import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot, saveSnapshot, githubConfigured } from '../src/github-store.js';

const env = { GITHUB_OWNER: 'choichoi3227-crypto', GITHUB_REPO: 'Cloud', GITHUB_TOKEN: 'fake-token-for-tests', GITHUB_BRANCH: 'main' };

function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => { globalThis.fetch = original; });
}

test('githubConfigured returns false when secrets are missing, true when all present', () => {
  assert.equal(githubConfigured({}), false);
  assert.equal(githubConfigured({ GITHUB_OWNER: 'a' }), false);
  assert.equal(githubConfigured(env), true);
});

test('loadSnapshot returns ok:true with data:null on a fresh repo (404 = no snapshot file yet)', async () => {
  await withMockFetch(async (url) => {
    assert.match(String(url), /contents\/data\/snapshot\.json/);
    return new Response('{"message":"Not Found"}', { status: 404 });
  }, async () => {
    const result = await loadSnapshot(env);
    assert.equal(result.ok, true);
    assert.equal(result.data, null);
  });
});

test('loadSnapshot decodes base64 UTF-8 (Korean) content correctly from the GitHub Contents API shape', async () => {
  const original = { users: [['admin@test.com', { email: 'admin@test.com', name: '관리자' }]] };
  const jsonText = JSON.stringify(original);
  const b64 = Buffer.from(jsonText, 'utf8').toString('base64');
  await withMockFetch(async () => {
    return new Response(JSON.stringify({ content: b64, sha: 'abc123' }), { status: 200 });
  }, async () => {
    const result = await loadSnapshot(env);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, original);
  });
});

test('saveSnapshot PUTs base64-encoded content to the Contents API and succeeds', async () => {
  let capturedBody = null;
  await withMockFetch(async (url, opts) => {
    if (!opts || !opts.method) {
      // sha lookup GET — pretend no existing file
      return new Response('not found', { status: 404 });
    }
    capturedBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({ content: { sha: 'newsha' } }), { status: 201 });
  }, async () => {
    const result = await saveSnapshot(env, { hello: 'world', 한글: '테스트' });
    assert.equal(result.ok, true);
    assert.ok(capturedBody.content); // base64 content was sent
    assert.equal(capturedBody.branch, 'main');
    const decoded = Buffer.from(capturedBody.content, 'base64').toString('utf8');
    assert.deepEqual(JSON.parse(decoded), { hello: 'world', 한글: '테스트' });
  });
});

test('saveSnapshot retries once on sha conflict (409) and succeeds on second attempt', async () => {
  let putAttempts = 0;
  await withMockFetch(async (url, opts) => {
    if (!opts || !opts.method) return new Response(JSON.stringify({ sha: 'sha-1' }), { status: 200 });
    putAttempts++;
    if (putAttempts === 1) return new Response('conflict', { status: 409 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, async () => {
    const result = await saveSnapshot(env, { attempt: 'retry-test' });
    assert.equal(result.ok, true);
    assert.equal(putAttempts, 2);
  });
});

test('loadSnapshot/saveSnapshot return not_configured when secrets are absent (no network call attempted)', async () => {
  let called = false;
  await withMockFetch(async () => { called = true; return new Response('{}', { status: 200 }); }, async () => {
    const loadResult = await loadSnapshot({});
    const saveResult = await saveSnapshot({}, { x: 1 });
    assert.equal(loadResult.ok, false);
    assert.equal(loadResult.reason, 'not_configured');
    assert.equal(saveResult.ok, false);
    assert.equal(saveResult.reason, 'not_configured');
    assert.equal(called, false);
  });
});
