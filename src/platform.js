/**
 * platform.js — CloudPress 비즈니스 로직 레이어
 * ================================================
 * - CloudPressDB / CP3 / SessionStore / AuditLog를 engine.js에서 import
 * - 모든 데이터 접근은 GitHub 기반 영속 엔진을 통함 (메모리 Map 미사용)
 * - 요청 컨텍스트(env)는 매 요청마다 인자로 전달
 */

'use strict';

import {
  CloudPressKV, CloudPressSQL, CloudPressDB,
  CP3, SessionStore, AuditLog,
  sha256, uid, body, sanitizeEmail, publicUser,
  secureHeaders, jsonRes, htmlRes, githubConfigured,
  clearRequestCache
} from './engine.js';

// ── 상품 카탈로그 ────────────────────────────────────────
export const catalog = Object.freeze({
  wordpress: {
    slug: 'wordpress', name: '워드프레스 호스팅',
    plans: { lite: 14, standard: 29, intelligent: 42, imperial: 59, duplex: 76 },
    common: ['무제한 트래픽', 'Cloudflare CDN 무료 제공', '자동 DNS 설정', '자동 FTP 기능'],
    limits: { lite: '개인 블로그/소형 사이트', standard: '성장형 사이트', intelligent: '고트래픽 최적화', imperial: '비즈니스 고가용성', duplex: '멀티 사이트 운영' },
    stack: ['php-wasm', 'CloudPressDB NoSQL', 'CP3 isolated storage']
  },
  cloudpressdb: {
    slug: 'cloudpressdb', name: 'CloudPressDB',
    price: 10,
    types: { 'wordpress-nosql': '워드프레스 스키마 Key-Value NoSQL', 'general-nosql': '범용 서버리스 KV NoSQL', 'general-sql': '자체 SQL 실행기 기반 서버리스 SQL' }
  },
  cp3: {
    slug: 'cp3', name: 'CP3',
    basePrice: 10, includedGb: 50, extraPerGb: 0.5,
    policy: 'R2/S3/외부 스토리지 미사용 자체 네임스페이스'
  },
  static: { slug: 'static', name: '정적 사이트', price: 0, stack: ['HTML', 'CSS', 'JS', 'edge cache'] },
  php:    { slug: 'php',    name: 'PHP 사이트',  price: 12, stack: ['php-wasm', 'isolated runtime'] }
});

// ── 서비스 네임스페이스 ──────────────────────────────────
export const serviceNamespaces = Object.freeze({
  database: 'cloudpress-service-db',
  storage:  'cloudpress-service-cp3',
  sql:      'cloudpress-service-sql'
});

// ── 가격 계산 ────────────────────────────────────────────
export function priceOf(input) {
  const p = catalog[input.product];
  if (!p) return null;
  if (input.product === 'wordpress') return p.plans[input.plan] || p.plans.lite;
  if (input.product === 'cp3') return p.basePrice + Math.max(0, Number(input.gb || p.includedGb) - p.includedGb) * p.extraPerGb;
  return p.price || 0;
}

// ── Admin 판별 ───────────────────────────────────────────
export function isAdmin(user) { return Boolean(user?.roles?.includes('admin')); }

export function adminEmailOf(env = {}) {
  return sanitizeEmail(env.ADMIN_EMAIL || env.ADMIN_BOOTSTRAP_EMAIL || '');
}

export function ensureAdminRole(user, env = {}) {
  if (!user) return user;
  const adminEmail = adminEmailOf(env);
  if (adminEmail && user.email === adminEmail && !user.roles?.includes('admin')) {
    user.roles = [...(user.roles || []), 'admin'];
  }
  return user;
}

// ── DB 접근 헬퍼 ─────────────────────────────────────────
// 사용자 데이터는 'users' 네임스페이스에 저장
function usersDB(env)    { return new CloudPressKV(env, 'users'); }
function ordersDB(env)   { return new CloudPressKV(env, 'orders'); }
function instancesDB(env){ return new CloudPressKV(env, 'instances'); }
function noticesDB(env)  { return new CloudPressKV(env, 'notices'); }

// ── 세션 ─────────────────────────────────────────────────
export async function currentUser(req, env = {}) {
  const cookie = req.headers.get('cookie') || '';
  const sid = (cookie.match(/(?:^|; )cp_session=([^;]+)/) || [])[1];
  if (!sid) return null;
  const store = new SessionStore(env);
  const session = await store.get(sid);
  if (!session) return null;
  const user = await usersDB(env).get(session.email);
  if (!user) return null;
  return ensureAdminRole(user, env);
}

export async function requireUser(req, env = {}) {
  const user = await currentUser(req, env);
  if (!user) return { error: jsonRes({ error: 'authentication required' }, 401) };
  return { user };
}

// ── Audit ────────────────────────────────────────────────
function auditLog(env) { return new AuditLog(env); }

// ── 서비스 플랫폼 초기화 ─────────────────────────────────
export async function ensureServicePlatform(env = {}) {
  const kv = new CloudPressKV(env, serviceNamespaces.database);
  const configured = await kv.get('site:config');
  if (!configured) {
    // 병렬로 초기화
    await Promise.all([
      kv.put('site:config', {
        name: '클라우드프레스', database: 'CloudPressDB', storage: 'CP3',
        capacity: 'unlimited', createdAt: new Date().toISOString()
      }),
      kv.put('runtime:domains', {
        bridge: 'bridge.{domain}', console: 'bridge-console.{domain}', sso: 'sso.{domain}'
      })
    ]);
    const sql = new CloudPressSQL(env, serviceNamespaces.sql);
    await sql.execute('CREATE TABLE IF NOT EXISTS service_events (id, type, at)');
    await sql.execute('INSERT INTO service_events (id, type, at) VALUES (?, ?, ?)', [uid('evt'), 'platform.bootstrap', new Date().toISOString()]);
    await new CP3(env, serviceNamespaces.storage).put('service/README.json', {
      owner: 'cloudpress-service', capacity: 'unlimited',
      purpose: 'service-site-assets-and-operational-metadata'
    });
  }
  return {
    kv,
    sql: new CloudPressSQL(env, serviceNamespaces.sql),
    storage: new CP3(env, serviceNamespaces.storage)
  };
}

export async function serviceSnapshot(env = {}) {
  const platform = await ensureServicePlatform(env);
  const [config, domains, kvItems, sqlResult, storageObjects] = await Promise.all([
    platform.kv.get('site:config'),
    platform.kv.get('runtime:domains'),
    platform.kv.list(),
    platform.sql.execute('SELECT * FROM service_events'),
    platform.storage.list()
  ]);
  return { config, domains, kvItems, sqlEvents: sqlResult.rows, storageObjects };
}

// ── 쿠키 도메인 ─────────────────────────────────────────
function cookieDomain(env = {}) {
  return env.COOKIE_DOMAIN ? `; Domain=${env.COOKIE_DOMAIN}` : '';
}

// ── 공개 re-export (worker.js에서 사용) ─────────────────
export {
  CloudPressKV, CloudPressSQL, CloudPressDB,
  CP3, SessionStore, AuditLog,
  sha256, uid, body, sanitizeEmail, publicUser,
  secureHeaders, jsonRes as json, htmlRes as html,
  githubConfigured, clearRequestCache
};

// 내부 헬퍼 (worker.js 전용)
export { usersDB, ordersDB, instancesDB, noticesDB, cookieDomain, auditLog };
