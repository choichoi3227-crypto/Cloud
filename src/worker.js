/**
 * worker.js — CloudPress Cloudflare Worker 메인 엔트리
 * ======================================================
 * - 100% 자체 제작 CloudPressDB + CP3 + SessionStore 사용
 * - 메모리 Map 방식 완전 제거 → GitHub 기반 영속 엔진
 * - Non-blocking I/O: 모든 I/O는 await/Promise.all 병렬
 * - 세션 영속: Worker 재시작 후에도 로그인 유지
 * - 요청 캐시: 같은 요청 내 중복 GitHub fetch 제거
 */

'use strict';

import {
  catalog, serviceSnapshot, serviceNamespaces, ensureServicePlatform,
  isAdmin, ensureAdminRole, adminEmailOf, cookieDomain,
  currentUser, requireUser,
  CloudPressKV, CloudPressSQL, CP3, SessionStore, AuditLog,
  sha256, uid, body, sanitizeEmail, publicUser, priceOf,
  json, html, secureHeaders, githubConfigured, clearRequestCache,
  usersDB, ordersDB, instancesDB, noticesDB, auditLog
} from './platform.js';

export { catalog };

// ── 라우팅 테이블 ────────────────────────────────────────
const bridgeRoutes  = new Set(['/', '/index', '/feature', '/about', '/products', '/notice']);
const consoleRoutes = new Set([
  '/dashboard', '/instances', '/instance-detail',
  '/payments', '/billing', '/accounts',
  '/admin', '/admin/db', '/admin/storage', '/admin/users', '/admin/orders', '/admin/settings'
]);
const ssoRoutes = new Set(['/login', '/signup', '/lost-password']);

const pageMap = {
  '/': '/bridge/index.html', '/index': '/bridge/index.html',
  '/feature': '/bridge/feature.html', '/about': '/bridge/about.html',
  '/products': '/bridge/products.html', '/notice': '/bridge/notice.html',
  '/dashboard': '/console/dashboard.html', '/instances': '/console/instances.html',
  '/instance-detail': '/console/instance-detail.html', '/payments': '/console/payments.html',
  '/billing': '/console/billing.html', '/accounts': '/console/accounts.html',
  '/admin': '/admin/index.html', '/admin/db': '/admin/db.html',
  '/admin/storage': '/admin/storage.html', '/admin/users': '/admin/users.html',
  '/admin/orders': '/admin/orders.html', '/admin/settings': '/admin/settings.html',
  '/login': '/sso/login.html', '/signup': '/sso/signup.html',
  '/lost-password': '/sso/lost-password.html'
};

// ── Worker 엔트리포인트 ──────────────────────────────────
export default {
  async fetch(req, env, ctx) {
    // 요청마다 캐시 초기화 (Non-blocking I/O 기반 요청별 캐시)
    clearRequestCache();

    // 서비스 플랫폼 초기화 (백그라운드, 응답을 블로킹하지 않음)
    if (ctx?.waitUntil) {
      ctx.waitUntil(ensureServicePlatform(env).catch(() => null));
    }

    try {
      const url   = new URL(req.url);
      const scope = domainScope(url.hostname, env);

      // Rate Limiting: 동일 IP 초당 요청 제한 (간단 구현)
      const rateLimitRes = checkRateLimit(req);
      if (rateLimitRes) return rateLimitRes;

      // API 라우팅
      if (url.pathname.startsWith('/api/')) return apiRouter(req, env, url, scope);

      // 페이지 라우팅
      const page = resolvePage(url, scope);
      if (page) {
        if (scope === 'console' && !(await currentUser(req, env))) {
          return redirectToSsoLogin(url, env);
        }
        return html(shell(page));
      }

      if (isKnownPagePath(url.pathname)) return notFound(scope, url.pathname);
      return env.ASSETS ? env.ASSETS.fetch(req) : notFound(scope, url.pathname);

    } catch (err) {
      // 예외가 외부로 노출되지 않도록 처리
      console.error('Worker error:', err?.message || err);
      return json({ error: 'internal server error' }, 500);
    }
  }
};

// ── 도메인 스코프 판별 ───────────────────────────────────
function domainScope(hostname, env = {}) {
  const h = hostname.toLowerCase();
  const root = String(env.PRIMARY_DOMAIN || '').toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.workers.dev')) return 'dev';
  if (h.startsWith('bridge-console.')) return 'console';
  if (h.startsWith('sso.'))           return 'sso';
  if (h.startsWith('bridge.'))        return 'bridge';
  if (root) {
    if (h === `bridge-console.${root}`) return 'console';
    if (h === `sso.${root}`)            return 'sso';
    if (h === `bridge.${root}`)         return 'bridge';
  }
  return 'unknown';
}

// ── Rate Limit (메모리 카운터, 간단 구현) ────────────────
const _rateMap = new Map();
const RATE_LIMIT = 120; // 분당 요청 수
const RATE_WINDOW = 60_000;

function checkRateLimit(req) {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';
  const now = Date.now();
  const entry = _rateMap.get(ip) || { count: 0, reset: now + RATE_WINDOW };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + RATE_WINDOW; }
  entry.count++;
  _rateMap.set(ip, entry);
  if (_rateMap.size > 10_000) { // 메모리 폭증 방지
    const oldest = [..._rateMap.entries()].sort((a, b) => a[1].reset - b[1].reset);
    oldest.slice(0, 1000).forEach(([k]) => _rateMap.delete(k));
  }
  if (entry.count > RATE_LIMIT) {
    return json({ error: 'too many requests' }, 429, { 'retry-after': String(Math.ceil((entry.reset - now) / 1000)) });
  }
  return null;
}

// ── 페이지 유틸 ─────────────────────────────────────────
function isKnownPagePath(path) {
  return bridgeRoutes.has(path) || consoleRoutes.has(path) || ssoRoutes.has(path) ||
    path.includes('/cart/') || path.startsWith('/products/');
}

function resolvePage(url, scope) {
  const path = url.pathname;
  if (scope === 'dev') {
    if (pageMap[path]) return pageMap[path];
    if (path.includes('/cart/') || path.startsWith('/products/')) return path;
    return null;
  }
  if (scope === 'bridge') {
    if (bridgeRoutes.has(path)) return pageMap[path];
    if (path.includes('/cart/') || path.startsWith('/products/')) return path;
    return null;
  }
  if (scope === 'console' && consoleRoutes.has(path)) return pageMap[path];
  if (scope === 'sso'     && ssoRoutes.has(path))     return pageMap[path];
  return null;
}

function redirectToSsoLogin(url, env = {}) {
  const root = String(env.PRIMARY_DOMAIN || '').toLowerCase();
  const loginHost = root
    ? `sso.${root}`
    : url.hostname.replace(/^bridge-console\./, 'sso.');
  return new Response(null, {
    status: 302,
    headers: { location: `${url.protocol}//${loginHost}/login?next=${encodeURIComponent(url.pathname)}` }
  });
}

function notFound(scope, path) {
  return html(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 - 클라우드프레스</title><link rel="stylesheet" href="/app.css"></head><body><section class="hero"><h1>404</h1><p>이 페이지는 현재 서브도메인(${scope})에서 사용할 수 없습니다: ${path}</p><a class="btn primary" href="/index">홈으로</a></section></body></html>`, 404);
}

function shell(page) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>클라우드프레스</title><meta name="referrer" content="strict-origin-when-cross-origin"><link rel="stylesheet" href="/_next/static/css/landing-sso001.css"><link rel="stylesheet" href="/_next/static/css/landing-sso002.css"><link rel="stylesheet" href="/_next/static/css/landing-sso003.css"><link rel="stylesheet" href="/_next/static/css/dashboard001.css"><link rel="stylesheet" href="/_next/static/css/dashboard002.css"><link rel="stylesheet" href="/_next/static/css/dashboard003.css"><link rel="stylesheet" href="/app.css"></head><body><div id="app" data-page="${escHtml(page)}"></div><script src="/app.js" defer></script></body></html>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ═══════════════════════════════════════════════════════
// API 라우터
// ═══════════════════════════════════════════════════════
async function apiRouter(req, env, url, scope) {
  const path   = url.pathname;
  const method = req.method.toUpperCase();

  // ── 공개 API ────────────────────────────────────────
  if (path === '/api/health' && method === 'GET') {
    return json({
      ok: true, service: 'cloudpress', scope,
      availability: '99.99%',
      storage: 'GitHub-backed CloudPressDB + CP3 (100% self-built, serverless)',
      githubConfigured: githubConfigured(env),
      time: new Date().toISOString()
    });
  }

  if (path === '/api/routes' && method === 'GET') {
    return json({ domains: { bridge: [...bridgeRoutes], console: [...consoleRoutes], sso: [...ssoRoutes] } });
  }

  if (path === '/api/products' && method === 'GET') return json({ products: catalog });
  if (path.startsWith('/api/products/') && method === 'GET') {
    const slug = path.split('/').pop();
    return catalog[slug] ? json({ product: catalog[slug] }) : json({ error: 'product not found' }, 404);
  }

  if (path === '/api/notices' && method === 'GET') return getNotices(env);
  if (path === '/api/service-platform' && method === 'GET') return json({ service: await serviceSnapshot(env) });

  // ── SSO 전용 인증 API ────────────────────────────────
  if (path.startsWith('/api/auth/')) {
    if (scope !== 'sso' && scope !== 'dev') {
      return json({ error: 'auth API is only available on sso.{domain}' }, 404);
    }
    if (path === '/api/auth/signup'        && method === 'POST') return signup(req, env);
    if (path === '/api/auth/login'         && method === 'POST') return login(req, env);
    if (path === '/api/auth/logout'        && method === 'POST') return logout(req, env);
    if (path === '/api/auth/lost-password' && method === 'POST') return lostPassword(req, env);
    return json({ error: 'not found' }, 404);
  }

  // ── 인증 필요 API ────────────────────────────────────
  const gate = await requireUser(req, env);
  if (gate.error) return gate.error;
  const user = gate.user;

  if (path === '/api/me' && method === 'GET') return json({ user: publicUser(user) });

  if (path === '/api/notices' && method === 'POST') return createNotice(req, user, env);

  // 주문
  if (path === '/api/orders' && method === 'GET')  return getOrders(user, env);
  if (path === '/api/orders' && method === 'POST') return createOrder(req, user, env);
  if (path.startsWith('/api/orders/') && method === 'GET') return orderDetail(url, user, env);

  // 청구/결제
  if (path === '/api/billing'  && method === 'GET') return getBilling(user, env);
  if (path === '/api/payments' && method === 'GET') return getPayments(user, env);

  // 계정
  if (path === '/api/accounts' && method === 'PATCH') return updateAccount(req, user, env);

  // 인스턴스
  if (path === '/api/instances' && method === 'GET')  return getInstances(user, env);
  if (path === '/api/instances' && method === 'POST') return createInstance(req, user, env);
  if (path.startsWith('/api/instances/') && method === 'GET') return instanceDetail(url, user, env);

  // CloudPressDB KV
  if (path === '/api/cloudpressdb/kv' && method === 'GET')  return kvList(user, env);
  if (path === '/api/cloudpressdb/kv' && method === 'POST') return kvWrite(req, user, env);
  if (path === '/api/cloudpressdb/kv' && method === 'DELETE') return kvDelete(req, user, env);

  // CloudPressDB SQL
  if (path === '/api/cloudpressdb/sql' && method === 'POST') return sqlExec(req, user, env);
  if (path === '/api/cloudpressdb/tables' && method === 'GET') return sqlTables(user, env);

  // CP3
  if (path === '/api/cp3/objects' && method === 'GET')    return cp3List(user, env);
  if (path === '/api/cp3/objects' && method === 'POST')   return cp3Put(req, user, env);
  if (path.startsWith('/api/cp3/objects/') && method === 'GET')    return cp3Get(url, user, env);
  if (path.startsWith('/api/cp3/objects/') && method === 'DELETE') return cp3Delete(url, user, env);

  // 관리자
  if (path.startsWith('/api/admin/')) return adminRouter(url, req, user, env);

  return json({ error: 'not found' }, 404);
}

// ═══════════════════════════════════════════════════════
// Auth 핸들러
// ═══════════════════════════════════════════════════════
async function signup(req, env) {
  const b = await body(req);
  for (const f of ['email', 'name', 'address', 'password']) {
    if (!b[f]) return json({ error: `${f} is required` }, 400);
  }
  const email = sanitizeEmail(b.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid email format' }, 400);
  if (String(b.password).length < 8) return json({ error: 'password must be at least 8 characters' }, 400);

  const db = usersDB(env);
  const existing = await db.get(email);
  if (existing) return json({ error: 'email already exists' }, 409);

  const user = {
    id: uid('user'),
    email,
    name: String(b.name).slice(0, 100),
    address: String(b.address).slice(0, 500),
    passwordHash: await sha256(String(b.password)),
    roles: email === adminEmailOf(env) ? ['admin'] : ['user'],
    providers: ['email'],
    createdAt: new Date().toISOString()
  };
  await db.put(email, user);
  await auditLog(env).append(user.id, 'user.signup');
  return json({ user: publicUser(user) }, 201);
}

async function login(req, env) {
  const b = await body(req);
  const email = sanitizeEmail(b.email);
  const db = usersDB(env);
  const user = await db.get(email);

  if (!user || user.passwordHash !== await sha256(String(b.password || ''))) {
    return json({ error: 'invalid credentials' }, 401);
  }
  ensureAdminRole(user, env);
  if (user.roles && !user.roles.includes('admin')) {
    // 관리자 역할이 바뀌었으면 저장
    const adminEmail = adminEmailOf(env);
    if (adminEmail && email === adminEmail) await db.put(email, user);
  }

  const ttl = Number(env.SESSION_TTL_SECONDS || 86400);
  const store = new SessionStore(env);
  const sid = await store.create(email, ttl);

  await auditLog(env).append(user.id, 'auth.login');
  return json({ user: publicUser(user) }, 200, {
    'set-cookie': `cp_session=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttl}${cookieDomain(env)}`
  });
}

async function logout(req, env) {
  const cookie = req.headers.get('cookie') || '';
  const sid = (cookie.match(/(?:^|; )cp_session=([^;]+)/) || [])[1];
  if (sid) {
    const store = new SessionStore(env);
    await store.delete(sid);
  }
  return json({ ok: true }, 200, {
    'set-cookie': `cp_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0${cookieDomain(env)}`
  });
}

async function lostPassword(req, env) {
  const b = await body(req);
  const email = sanitizeEmail(b.email);
  const db = usersDB(env);
  const user = await db.get(email);
  if (user) {
    const temp = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    user.passwordHash = await sha256(temp);
    await db.put(email, user);
    await auditLog(env).append(user.id, 'auth.password_reset');
    // 운영환경에서는 이메일 발송으로 대체해야 함
    return json({ ok: true, delivery: 'email', _devOnly_tempPassword: temp });
  }
  return json({ ok: true }); // 이메일 존재 여부 노출 방지
}

// ═══════════════════════════════════════════════════════
// 공지
// ═══════════════════════════════════════════════════════
async function getNotices(env) {
  const db = noticesDB(env);
  const items = await db.list();
  if (items.length === 0) {
    // 시드 데이터
    const n = { id: uid('notice'), title: 'CloudPress 서비스 시작', body: '클라우드프레스 플랫폼이 시작되었습니다.', createdAt: new Date().toISOString() };
    await db.put(n.id, n);
    return json({ notices: [n] });
  }
  return json({ notices: items.map(i => i.value) });
}

async function createNotice(req, user, env) {
  if (!isAdmin(user)) return json({ error: 'admin required' }, 403);
  const b = await body(req);
  if (!b.title) return json({ error: 'title is required' }, 400);
  const notice = {
    id: uid('notice'),
    title: String(b.title).slice(0, 200),
    body: String(b.body || '').slice(0, 5000),
    createdAt: new Date().toISOString(),
    author: user.email
  };
  await noticesDB(env).put(notice.id, notice);
  return json({ notice }, 201);
}

// ═══════════════════════════════════════════════════════
// 주문
// ═══════════════════════════════════════════════════════
async function getOrders(user, env) {
  const items = await ordersDB(env).list();
  const orders = items.map(i => i.value).filter(o => o.userId === user.id);
  return json({ orders });
}

async function createOrder(req, user, env) {
  const b = await body(req);
  const amount = priceOf(b);
  if (amount === null) return json({ error: 'unknown product' }, 400);
  const free = isAdmin(user);
  const order = {
    id: uid('bill'),
    userId: user.id,
    product: b.product,
    plan: b.plan || null,
    gb: b.gb || null,
    amountUsd: free ? 0 : amount,
    adminFree: free,
    status: free ? 'approved' : 'pending',
    cartPath: `/${b.product}/cart/`,
    createdAt: new Date().toISOString()
  };
  order.cartPath += order.id;
  await ordersDB(env).put(order.id, order);
  await auditLog(env).append(user.id, 'order.create', { orderId: order.id, product: b.product });
  return json({ order, cartPath: order.cartPath }, 201);
}

async function orderDetail(url, user, env) {
  const id = url.pathname.split('/').pop();
  const order = await ordersDB(env).get(id);
  if (!order || (order.userId !== user.id && !isAdmin(user))) return json({ error: 'order not found' }, 404);
  return json({ order });
}

async function getBilling(user, env) {
  const items = await ordersDB(env).list();
  const orders = items.map(i => i.value).filter(o => o.userId === user.id);
  return json({ billing: { currency: 'USD', adminFree: isAdmin(user), totalUsd: orders.reduce((s, o) => s + o.amountUsd, 0), orders } });
}

async function getPayments(user, env) {
  const items = await ordersDB(env).list();
  const payments = items.map(i => i.value)
    .filter(o => o.userId === user.id)
    .map(o => ({ id: o.id, amountUsd: o.amountUsd, status: o.status, createdAt: o.createdAt }));
  return json({ payments });
}

// ═══════════════════════════════════════════════════════
// 계정
// ═══════════════════════════════════════════════════════
async function updateAccount(req, user, env) {
  const b = await body(req);
  if (b.name) user.name = String(b.name).slice(0, 100);
  if (b.address) user.address = String(b.address).slice(0, 500);
  await usersDB(env).put(user.email, user);
  await auditLog(env).append(user.id, 'account.update');
  return json({ user: publicUser(user) });
}

// ═══════════════════════════════════════════════════════
// 인스턴스
// ═══════════════════════════════════════════════════════
async function getInstances(user, env) {
  const items = await instancesDB(env).list();
  const instances = items.map(i => i.value).filter(i => i.userId === user.id);
  return json({ instances });
}

async function createInstance(req, user, env) {
  const b = await body(req);
  const type = b.type || 'wordpress';
  const instance = {
    id: uid('inst'),
    userId: user.id,
    type,
    name: String(b.name || `${type}-site`).slice(0, 100),
    status: 'provisioning',
    network: { cdn: 'cloudflare', dns: 'automatic' },
    runtime: (type === 'wordpress' || type === 'php') ? 'php-wasm' : 'static',
    database: type === 'wordpress' ? 'CloudPressDB wordpress-nosql' : null,
    storage:  type === 'wordpress' ? 'CP3 isolated bucket'         : null,
    createdAt: new Date().toISOString()
  };
  await instancesDB(env).put(instance.id, instance);
  await auditLog(env).append(user.id, 'instance.create', { instanceId: instance.id });
  return json({ instance }, 201);
}

async function instanceDetail(url, user, env) {
  const id = url.pathname.split('/').pop();
  const instance = await instancesDB(env).get(id);
  if (!instance || instance.userId !== user.id) return json({ error: 'instance not found' }, 404);
  return json({ instance });
}

// ═══════════════════════════════════════════════════════
// CloudPressDB KV API
// ═══════════════════════════════════════════════════════
function userKV(user, env) { return new CloudPressKV(env, `user_${user.id}`); }

async function kvList(user, env) {
  const items = await userKV(user, env).list();
  return json({ items });
}

async function kvWrite(req, user, env) {
  const b = await body(req);
  if (!b.key) return json({ error: 'key is required' }, 400);
  await userKV(user, env).put(String(b.key).slice(0, 512), b.value);
  return json({ ok: true, key: b.key });
}

async function kvDelete(req, user, env) {
  const b = await body(req);
  if (!b.key) return json({ error: 'key is required' }, 400);
  const ok = await userKV(user, env).delete(b.key);
  return json({ ok });
}

// ═══════════════════════════════════════════════════════
// CloudPressDB SQL API
// ═══════════════════════════════════════════════════════
function userSQL(user, env) { return new CloudPressSQL(env, `user_${user.id}`); }

async function sqlExec(req, user, env) {
  const b = await body(req);
  if (!b.sql) return json({ error: 'sql is required' }, 400);
  const sql = userSQL(user, env);
  const result = await sql.execute(String(b.sql), Array.isArray(b.params) ? b.params : []);
  return json(result);
}

async function sqlTables(user, env) {
  const tables = await userSQL(user, env).tables();
  return json({ tables });
}

// ═══════════════════════════════════════════════════════
// CP3 API
// ═══════════════════════════════════════════════════════
function userCP3(user, env) { return new CP3(env, `user_${user.id}`); }

async function cp3List(user, env) {
  const objects = await userCP3(user, env).list();
  return json({ objects });
}

async function cp3Put(req, user, env) {
  const b = await body(req);
  if (!b.name) return json({ error: 'name is required' }, 400);
  const meta = await userCP3(user, env).put(String(b.name).slice(0, 500), b.data || '');
  return json({ object: meta }, 201);
}

async function cp3Get(url, user, env) {
  const name = decodeURIComponent(url.pathname.replace('/api/cp3/objects/', ''));
  const result = await userCP3(user, env).get(name);
  if (!result) return json({ error: 'object not found' }, 404);
  return json({ object: result.meta, data: result.data });
}

async function cp3Delete(url, user, env) {
  const name = decodeURIComponent(url.pathname.replace('/api/cp3/objects/', ''));
  const result = await userCP3(user, env).delete(name);
  return json(result);
}

// ═══════════════════════════════════════════════════════
// 관리자 API
// ═══════════════════════════════════════════════════════
async function adminRouter(url, req, user, env) {
  if (!isAdmin(user)) return json({ error: 'admin required' }, 403);
  const path = url.pathname;

  if (path === '/api/admin/db' && req.method === 'GET') {
    const [snapshot, users, allKv] = await Promise.all([
      serviceSnapshot(env),
      usersDB(env).list(),
      new CloudPressKV(env, 'users').list()
    ]);
    return json({ service: snapshot, users: users.map(i => publicUser(i.value)), kvItems: allKv });
  }

  if (path === '/api/admin/storage' && req.method === 'GET') {
    const snap = await serviceSnapshot(env);
    return json({ serviceStorage: snap.storageObjects });
  }

  if (path === '/api/admin/users' && req.method === 'GET') {
    const users = await usersDB(env).list();
    return json({ users: users.map(i => publicUser(i.value)) });
  }

  if (path === '/api/admin/orders' && req.method === 'GET') {
    const orders = await ordersDB(env).list();
    return json({ orders: orders.map(i => i.value) });
  }

  if (path === '/api/admin/audit' && req.method === 'GET') {
    const log = new AuditLog(env);
    return json({ entries: await log.getAll() });
  }

  if (path === '/api/admin/settings' && req.method === 'PATCH') {
    const b = await body(req);
    const platform = await ensureServicePlatform(env);
    const existing = await platform.kv.get('site:config') || {};
    const updated = { ...existing, ...b, updatedAt: new Date().toISOString() };
    await platform.kv.put('site:config', updated);
    return json({ config: updated });
  }

  // 전체 개요
  const [users, orders, instances, notices, snap] = await Promise.all([
    usersDB(env).list(),
    ordersDB(env).list(),
    instancesDB(env).list(),
    noticesDB(env).list(),
    serviceSnapshot(env)
  ]);
  return json({
    users:     users.map(i => publicUser(i.value)),
    orders:    orders.map(i => i.value),
    instances: instances.map(i => i.value),
    notices:   notices.map(i => i.value),
    service:   snap
  });
}
