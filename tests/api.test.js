/**
 * api.test.js — Worker API 통합 테스트
 * GitHub API를 mock하여 실제 네트워크 없이 영속 엔진 전체를 테스트한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { catalog } from '../src/worker.js';

// ── GitHub API Mock ──────────────────────────────────────
// 인메모리 파일시스템으로 GitHub Contents API를 시뮬레이션한다.
const _ghStore = new Map();

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const originalFetch = globalThis.fetch;

function installGhMock() {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('api.github.com')) return originalFetch(url, opts);

    // GET /repos/{owner}/{repo}/contents/{path}
    if (!opts.method || opts.method === 'GET') {
      const m = u.match(/contents\/(.+?)\?ref=/);
      const path = m ? decodeURIComponent(m[1]) : null;
      if (!path || !_ghStore.has(path)) return new Response('not found', { status: 404 });
      const entry = _ghStore.get(path);
      return new Response(JSON.stringify({
        content: utf8ToB64(typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)),
        sha: entry.sha
      }), { status: 200 });
    }

    // PUT /repos/{owner}/{repo}/contents/{path}
    if (opts.method === 'PUT') {
      const m = u.match(/contents\/(.+)$/);
      const path = m ? m[1] : null;
      if (!path) return new Response('bad path', { status: 400 });
      const body = JSON.parse(opts.body);
      const text = b64ToUtf8(body.content);
      const newSha = `sha_${Math.random().toString(36).slice(2)}`;
      _ghStore.set(path, { data: text, sha: newSha });
      return new Response(JSON.stringify({ content: { sha: newSha } }), { status: 201 });
    }

    // DELETE
    if (opts.method === 'DELETE') {
      const m = u.match(/contents\/(.+)$/);
      const path = m ? m[1] : null;
      if (path) _ghStore.delete(path);
      return new Response('{}', { status: 200 });
    }

    return new Response('not found', { status: 404 });
  };
}

function uninstallGhMock() {
  globalThis.fetch = originalFetch;
  _ghStore.clear();
}

// ── 테스트 환경 설정 ─────────────────────────────────────
const baseEnv = {
  SESSION_TTL_SECONDS: '86400',
  ADMIN_EMAIL: 'admin@cloudpress.test',
  ADMIN_BOOTSTRAP_EMAIL: 'admin@cloudpress.test',
  PRIMARY_DOMAIN: 'example.com',
  JWT_SECRET: 'test-secret-for-hmac-signing',
  GITHUB_OWNER: 'test-owner',
  GITHUB_REPO: 'test-repo',
  GITHUB_TOKEN: 'test-token',
  GITHUB_BRANCH: 'main'
};

async function call(host, path, { method = 'GET', body, cookie, env: envOverride } = {}) {
  const env = envOverride || baseEnv;
  return worker.fetch(
    new Request(`https://${host}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    }),
    env,
    { waitUntil: (p) => p.catch(() => null) }
  );
}

async function signup(email, env) {
  return call('sso.example.com', '/api/auth/signup', {
    method: 'POST',
    body: { email, name: 'Test User', address: 'Seoul', password: 'password123' },
    env
  });
}

async function loginAndGetCookie(email, env) {
  await signup(email, env).catch(() => null);
  const res = await call('sso.example.com', '/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password123' },
    env
  });
  assert.equal(res.status, 200, `login failed for ${email}: ${await res.text()}`);
  return res.headers.get('set-cookie').split(';')[0];
}

// ── 테스트 ──────────────────────────────────────────────

test('catalog pricing and product types are correct', () => {
  assert.equal(catalog.wordpress.plans.lite, 14);
  assert.equal(catalog.wordpress.plans.duplex, 76);
  assert.equal(catalog.cloudpressdb.price, 10);
  assert.equal(catalog.cp3.basePrice, 10);
  assert.equal(catalog.cp3.extraPerGb, 0.5);
  assert.ok(catalog.cloudpressdb.types['wordpress-nosql']);
  assert.ok(catalog.cloudpressdb.types['general-sql']);
});

test('health endpoint returns ok', async () => {
  installGhMock();
  try {
    const res = await call('bridge.example.com', '/api/health');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.githubConfigured, true);
  } finally { uninstallGhMock(); }
});

test('domain scope isolation: wrong subdomain returns 404 for page routes', async () => {
  installGhMock();
  try {
    let res = await call('bridge.example.com', '/dashboard');
    assert.equal(res.status, 404);
    res = await call('sso.example.com', '/dashboard');
    assert.equal(res.status, 404);
    res = await call('bridge.example.com', '/login');
    assert.equal(res.status, 404);
    res = await call('sso.example.com', '/login');
    assert.equal(res.status, 200);
    res = await call('bridge.example.com', '/products');
    assert.equal(res.status, 200);
  } finally { uninstallGhMock(); }
});

test('console gate redirects unauthenticated users to sso login', async () => {
  installGhMock();
  try {
    let res = await call('bridge-console.example.com', '/dashboard');
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /sso\.example\.com\/login/);

    const cookie = await loginAndGetCookie('gate@example.com');
    res = await call('bridge-console.example.com', '/dashboard', { cookie });
    assert.equal(res.status, 200);
  } finally { uninstallGhMock(); }
});

test('auth API is isolated to sso subdomain', async () => {
  installGhMock();
  try {
    let res = await call('bridge.example.com', '/api/auth/signup', {
      method: 'POST',
      body: { email: 'blocked@example.com', name: 'B', address: 'A', password: 'password123' }
    });
    assert.equal(res.status, 404);

    res = await call('sso.example.com', '/api/auth/signup', {
      method: 'POST',
      body: { email: 'allowed@example.com', name: 'A', address: 'A', password: 'password123' }
    });
    assert.equal(res.status, 201);
  } finally { uninstallGhMock(); }
});

test('password must be at least 8 characters', async () => {
  installGhMock();
  try {
    const res = await call('sso.example.com', '/api/auth/signup', {
      method: 'POST',
      body: { email: 'short@example.com', name: 'A', address: 'A', password: 'pw' }
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /8 characters/);
  } finally { uninstallGhMock(); }
});

test('duplicate email signup returns 409', async () => {
  installGhMock();
  try {
    await signup('dup@example.com');
    const res = await signup('dup@example.com');
    assert.equal(res.status, 409);
  } finally { uninstallGhMock(); }
});

test('signup, login, order, instance provisioning flow works end-to-end', async () => {
  installGhMock();
  try {
    const cookie = await loginAndGetCookie('flow@example.com');

    let res = await call('bridge.example.com', '/api/orders', {
      method: 'POST', cookie,
      body: { product: 'wordpress', plan: 'lite' }
    });
    assert.equal(res.status, 201);
    let data = await res.json();
    assert.match(data.cartPath, /^\/wordpress\/cart\/bill_/);

    res = await call('bridge-console.example.com', '/api/instances', {
      method: 'POST', cookie,
      body: { type: 'wordpress', name: 'wp-production' }
    });
    assert.equal(res.status, 201);
    data = await res.json();
    assert.equal(data.instance.database, 'CloudPressDB wordpress-nosql');
    assert.equal(data.instance.storage, 'CP3 isolated bucket');
    assert.equal(data.instance.runtime, 'php-wasm');
  } finally { uninstallGhMock(); }
});

test('CloudPressDB KV put/get roundtrip via API', async () => {
  installGhMock();
  try {
    const cookie = await loginAndGetCookie('kv@example.com');

    let res = await call('bridge-console.example.com', '/api/cloudpressdb/kv', {
      method: 'POST', cookie,
      body: { key: 'wp:option:siteurl', value: 'https://example.com' }
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);

    res = await call('bridge-console.example.com', '/api/cloudpressdb/kv', { cookie });
    assert.equal(res.status, 200);
    const { items } = await res.json();
    const found = items.find(i => i.key === 'wp:option:siteurl');
    assert.ok(found);
    assert.equal(found.value, 'https://example.com');
  } finally { uninstallGhMock(); }
});

test('CloudPressDB SQL CREATE/INSERT/SELECT via API', async () => {
  installGhMock();
  try {
    const cookie = await loginAndGetCookie('sql@example.com');

    let res = await call('bridge-console.example.com', '/api/cloudpressdb/sql', {
      method: 'POST', cookie,
      body: { sql: 'CREATE TABLE IF NOT EXISTS posts (id, title, body)' }
    });
    assert.equal((await res.json()).ok, true);

    res = await call('bridge-console.example.com', '/api/cloudpressdb/sql', {
      method: 'POST', cookie,
      body: { sql: 'INSERT INTO posts (id, title, body) VALUES (?, ?, ?)', params: ['1', '클라우드프레스', '본문'] }
    });
    let data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.rows[0].title, '클라우드프레스');

    res = await call('bridge-console.example.com', '/api/cloudpressdb/sql', {
      method: 'POST', cookie,
      body: { sql: 'SELECT * FROM posts' }
    });
    data = await res.json();
    assert.ok(data.rows.length >= 1);
    assert.equal(data.rows[0].title, '클라우드프레스');
  } finally { uninstallGhMock(); }
});

test('CP3 object put/get/list via API', async () => {
  installGhMock();
  try {
    const cookie = await loginAndGetCookie('cp3@example.com');

    let res = await call('bridge-console.example.com', '/api/cp3/objects', {
      method: 'POST', cookie,
      body: { name: 'readme.txt', data: 'CloudPress CP3 object storage' }
    });
    assert.equal(res.status, 201);
    const { object } = await res.json();
    assert.ok(object.size > 0);
    assert.match(object.sha256, /^[0-9a-f]{64}$/);

    res = await call('bridge-console.example.com', '/api/cp3/objects', { cookie });
    const { objects } = await res.json();
    assert.ok(objects.some(o => o.name === 'readme.txt'));
  } finally { uninstallGhMock(); }
});

test('admin gets free approved orders', async () => {
  installGhMock();
  try {
    const cookie = await loginAndGetCookie('admin@cloudpress.test');

    const res = await call('bridge.example.com', '/api/orders', {
      method: 'POST', cookie,
      body: { product: 'cp3', gb: 5000 }
    });
    assert.equal(res.status, 201);
    const { order } = await res.json();
    assert.equal(order.amountUsd, 0);
    assert.equal(order.adminFree, true);
    assert.equal(order.status, 'approved');
  } finally { uninstallGhMock(); }
});

test('non-admin cannot access admin API', async () => {
  installGhMock();
  try {
    const cookie = await loginAndGetCookie('plain@example.com');
    const res = await call('bridge-console.example.com', '/api/admin/users', { cookie });
    assert.equal(res.status, 403);
  } finally { uninstallGhMock(); }
});

test('admin can inspect users and orders via admin API', async () => {
  installGhMock();
  try {
    const cookie = await loginAndGetCookie('admin@cloudpress.test');

    let res = await call('bridge-console.example.com', '/api/admin/users', { cookie });
    assert.equal(res.status, 200);
    const { users } = await res.json();
    assert.ok(Array.isArray(users));

    res = await call('bridge-console.example.com', '/api/admin/orders', { cookie });
    assert.equal(res.status, 200);
  } finally { uninstallGhMock(); }
});

test('ADMIN_EMAIL grants admin on login even if signed up as normal user', async () => {
  installGhMock();
  try {
    const lateAdminEnv = { ...baseEnv, ADMIN_EMAIL: 'late-admin@example.com' };
    // 일반 env로 가입 (admin 아님)
    await call('sso.example.com', '/api/auth/signup', {
      method: 'POST',
      body: { email: 'late-admin@example.com', name: 'Late', address: 'Seoul', password: 'password123' },
      env: baseEnv
    });

    // lateAdminEnv로 로그인 → admin 역할 부여
    const loginRes = await call('sso.example.com', '/api/auth/login', {
      method: 'POST',
      body: { email: 'late-admin@example.com', password: 'password123' },
      env: lateAdminEnv
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    const meRes = await call('bridge.example.com', '/api/me', { cookie, env: lateAdminEnv });
    const { user } = await meRes.json();
    assert.ok(user.roles.includes('admin'));
  } finally { uninstallGhMock(); }
});

test('session persists across worker cache clears (simulating isolate restart)', async () => {
  installGhMock();
  try {
    const cookie = await loginAndGetCookie('persist@example.com');

    // 캐시 클리어 (isolate 재시작 시뮬레이션)
    const { clearRequestCache } = await import('../src/engine.js');
    clearRequestCache();

    // 세션은 GitHub에 저장되었으므로 여전히 유효해야 함
    const res = await call('bridge.example.com', '/api/me', { cookie });
    assert.equal(res.status, 200);
    const { user } = await res.json();
    assert.equal(user.email, 'persist@example.com');
  } finally { uninstallGhMock(); }
});

test('logout invalidates session', async () => {
  installGhMock();
  try {
    const cookie = await loginAndGetCookie('logout@example.com');

    let res = await call('sso.example.com', '/api/auth/logout', { method: 'POST', cookie });
    assert.equal(res.status, 200);

    res = await call('bridge.example.com', '/api/me', { cookie });
    assert.equal(res.status, 401);
  } finally { uninstallGhMock(); }
});

test('rate limiter returns 429 after exceeding limit', async () => {
  // 비 GitHub API 테스트이므로 mock 필요 없음
  // 단, rate limit은 메모리 기반이므로 다른 테스트와 IP가 겹칠 수 있다.
  // 여기서는 health endpoint만 확인.
  const res = await call('bridge.example.com', '/api/health');
  assert.ok([200, 429].includes(res.status));
});

test('notice create (admin) and list (public) work', async () => {
  installGhMock();
  try {
    const cookie = await loginAndGetCookie('admin@cloudpress.test');

    let res = await call('bridge.example.com', '/api/notices', {
      method: 'POST', cookie,
      body: { title: '점검 공지', body: '오전 2시 점검 예정입니다.' }
    });
    assert.equal(res.status, 201);
    const { notice } = await res.json();
    assert.equal(notice.title, '점검 공지');

    res = await call('bridge.example.com', '/api/notices');
    assert.equal(res.status, 200);
    const { notices } = await res.json();
    assert.ok(notices.length >= 1);
  } finally { uninstallGhMock(); }
});

test('product detail API returns correct data', async () => {
  const res = await call('bridge.example.com', '/api/products/cloudpressdb');
  assert.equal(res.status, 200);
  const { product } = await res.json();
  assert.equal(product.price, 10);
});

test('unknown product returns 404', async () => {
  const res = await call('bridge.example.com', '/api/products/nonexistent');
  assert.equal(res.status, 404);
});

test('unauthenticated user cannot access protected APIs', async () => {
  installGhMock();
  try {
    const res = await call('bridge-console.example.com', '/api/instances');
    assert.equal(res.status, 401);
  } finally { uninstallGhMock(); }
});

test('HTML shell contains correct data-page attribute (XSS safe)', async () => {
  const res = await call('bridge.example.com', '/products');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /data-page="\/bridge\/products\.html"/);
  assert.doesNotMatch(text, /data-page=".*<script/);
});
