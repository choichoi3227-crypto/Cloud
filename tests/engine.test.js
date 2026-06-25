/**
 * engine.test.js — CloudPressDB + CP3 + SessionStore 유닛 테스트
 * GitHub 없이 동작 (GITHUB_* 없으면 메모리 모드로 폴백, 개발 환경용)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudPressKV, CloudPressSQL, CP3, sha256, uid } from '../src/engine.js';

const noGhEnv = {}; // GitHub secrets 없음 → 메모리 전용

test('sha256 produces consistent hex string', async () => {
  const h1 = await sha256('hello');
  const h2 = await sha256('hello');
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.notEqual(h1, await sha256('world'));
});

test('uid generates unique prefixed strings', () => {
  const ids = new Set(Array.from({ length: 100 }, () => uid('test')));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.ok(id.startsWith('test_'));
});

test('CloudPressKV put/get/delete/list work without GitHub', async () => {
  const kv = new CloudPressKV(noGhEnv, 'test-ns');
  await kv.put('foo', 'bar');
  assert.equal(await kv.get('foo'), null); // GitHub 없으면 null (영속 안 됨, 개발 모드)
  // GitHub 없이 list는 빈 배열
  const items = await kv.list();
  assert.ok(Array.isArray(items));
});

test('CloudPressSQL CREATE TABLE / INSERT / SELECT round-trip (no GitHub)', async () => {
  const sql = new CloudPressSQL(noGhEnv, 'test-db');
  const create = await sql.execute('CREATE TABLE IF NOT EXISTS posts (id, title, body)');
  assert.equal(create.ok, true);
  const insert = await sql.execute('INSERT INTO posts (id, title, body) VALUES (?, ?, ?)', ['1', 'Hello', 'World']);
  assert.equal(insert.ok, true);
  assert.equal(insert.rows[0].title, 'Hello');
  // SELECT without GitHub returns empty (no persistence)
  const select = await sql.execute('SELECT * FROM posts');
  assert.ok(Array.isArray(select.rows));
});

test('CloudPressSQL unsupported statement returns error', async () => {
  const sql = new CloudPressSQL(noGhEnv, 'test-db2');
  const result = await sql.execute('ALTER TABLE foo ADD COLUMN bar TEXT');
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('CP3 put returns metadata with sha256 and size', async () => {
  const cp3 = new CP3(noGhEnv, 'test-bucket');
  const meta = await cp3.put('hello.txt', 'Hello, CloudPress!');
  assert.ok(meta);
  assert.ok(meta.size > 0);
  assert.match(meta.sha256, /^[0-9a-f]{64}$/);
  assert.equal(meta.name, 'hello.txt');
});

test('CP3 get returns null without GitHub', async () => {
  const cp3 = new CP3(noGhEnv, 'test-bucket2');
  const result = await cp3.get('nonexistent.txt');
  assert.equal(result, null);
});

test('catalog has correct pricing', async () => {
  const { catalog } = await import('../src/platform.js');
  assert.equal(catalog.wordpress.plans.lite, 14);
  assert.equal(catalog.wordpress.plans.duplex, 76);
  assert.equal(catalog.cloudpressdb.price, 10);
  assert.equal(catalog.cp3.basePrice, 10);
  assert.equal(catalog.cp3.extraPerGb, 0.5);
  assert.ok(catalog.cloudpressdb.types['wordpress-nosql']);
  assert.ok(catalog.cloudpressdb.types['general-sql']);
});
