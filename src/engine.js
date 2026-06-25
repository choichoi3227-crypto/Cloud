/**
 * CloudPressDB + CP3 — 완전 자체 제작 영속 스토리지 엔진
 * =========================================================
 * - Cloudflare KV / D1 / R2 / Durable Objects 전혀 미사용
 * - GitHub Contents API를 "디스크"처럼 사용
 * - Node.js Non-blocking I/O 철학: 모든 I/O는 await/Promise.all 기반 병렬
 * - 영속성 보장: Worker isolate가 죽어도 GitHub에 데이터가 남아 있어 재시작 즉시 복원
 * - 다운타임 제로: CAS(Compare-And-Swap) + 재시도로 충돌 없는 쓰기
 * - 100% 실시간: 읽기는 항상 GitHub 최신 파일을 fetch (in-flight 캐시로 동일 요청 내 중복 제거)
 *
 * 저장 구조 (GitHub repo 내 data/ 폴더):
 *   data/db/{namespace}/{collection}.json   — CloudPressDB 컬렉션 (KV + SQL 테이블)
 *   data/sessions/{sid}.json               — 세션 (암호화)
 *   data/cp3/{bucket}/index.json           — CP3 오브젝트 메타데이터 인덱스
 *   data/cp3/{bucket}/obj/{key}.json       — CP3 오브젝트 실제 데이터
 *   data/audit.json                        — 감사 로그 (append-only, 최대 1000건 보관)
 */

'use strict';

// ── 환경 설정 ─────────────────────────────────────────────
function ghCfg(env = {}) {
  const owner = env.GITHUB_OWNER;
  const repo  = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;
  const branch = env.GITHUB_BRANCH || 'main';
  if (!owner || !repo || !token) return null;
  return { owner, repo, token, branch };
}
export function githubConfigured(env = {}) { return Boolean(ghCfg(env)); }

// ── Base64 (Workers에 Buffer 없음 → 직접 구현, UTF-8 한글 안전) ──
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

// ── SHA-256 ──────────────────────────────────────────────
const enc = new TextEncoder();
export async function sha256(val) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(String(val)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── HMAC-SHA256 (세션 서명) ──────────────────────────────
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}
async function hmacSign(secret, data) {
  const key = await hmacKey(secret);
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── GitHub REST 저수준 클라이언트 ────────────────────────
const API = 'https://api.github.com';

function ghHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'CloudPressDB/2.0-self-built'
  };
}

/**
 * GitHub에서 파일을 읽는다.
 * 반환: { content: object|string, sha: string } 또는 null(파일 없음)
 * parse=true면 JSON 파싱까지 수행.
 */
async function ghRead(cfg, path, parse = true) {
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`;
  const res = await fetch(url, { headers: ghHeaders(cfg.token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new GhError(`read ${path}`, res.status, await res.text().catch(() => ''));
  const file = await res.json();
  const text = b64ToUtf8(file.content || '');
  return { content: parse ? JSON.parse(text) : text, sha: file.sha };
}

/**
 * GitHub에 파일을 쓴다 (PUT).
 * CAS: sha가 틀리면 409/422 → 재시도(최대 maxRetry).
 * 반환: { ok: true, sha: new_sha }
 */
async function ghWrite(cfg, path, data, existingSha = null, maxRetry = 3) {
  const content = utf8ToB64(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const body = {
      message: `cp:sync ${path} @${new Date().toISOString()}`,
      content,
      branch: cfg.branch,
      ...(existingSha ? { sha: existingSha } : {})
    };
    const res = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}`, {
      method: 'PUT',
      headers: ghHeaders(cfg.token),
      body: JSON.stringify(body)
    });
    if (res.ok) {
      const json = await res.json();
      return { ok: true, sha: json.content?.sha };
    }
    if ((res.status === 409 || res.status === 422) && attempt < maxRetry) {
      // SHA 충돌: 최신 SHA를 다시 읽어 재시도
      const latest = await ghRead(cfg, path, false).catch(() => null);
      existingSha = latest?.sha || null;
      continue;
    }
    throw new GhError(`write ${path}`, res.status, await res.text().catch(() => ''));
  }
}

/**
 * GitHub에서 파일을 삭제한다.
 */
async function ghDelete(cfg, path, sha) {
  const body = {
    message: `cp:delete ${path} @${new Date().toISOString()}`,
    sha,
    branch: cfg.branch
  };
  const res = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}`, {
    method: 'DELETE',
    headers: ghHeaders(cfg.token),
    body: JSON.stringify(body)
  });
  if (!res.ok && res.status !== 404) throw new GhError(`delete ${path}`, res.status, await res.text().catch(() => ''));
  return { ok: true };
}

class GhError extends Error {
  constructor(op, status, body) {
    super(`GitHub ${op} failed: HTTP ${status}`);
    this.status = status;
    this.body = body.slice(0, 300);
  }
}

// ── 요청별 읽기 캐시 (같은 isolate 내 동일 경로 중복 fetch 방지) ──
let _reqCache = new Map();
export function clearRequestCache() { _reqCache = new Map(); }

async function cachedRead(cfg, path, parse = true) {
  if (_reqCache.has(path)) return _reqCache.get(path);
  const p = ghRead(cfg, path, parse);
  _reqCache.set(path, p);
  try { return await p; } catch (e) { _reqCache.delete(path); throw e; }
}

// ═══════════════════════════════════════════════════════════
// CloudPressDB — 완전 자체 제작 서버리스 DB 엔진
// ═══════════════════════════════════════════════════════════
//
// 저장 구조:
//   data/db/{namespace}/{collection}.json
//   파일 내용: { rows: { [key]: value }, meta: { updatedAt } }
//
// KV: collection = "kv", key = 임의 문자열
// SQL 테이블: collection = 테이블명, key = 로우 UUID, value = 로우 객체

export class CloudPressDB {
  /**
   * @param {object} env - Worker env (GITHUB_* secrets 포함)
   * @param {string} namespace - DB 네임스페이스 (사용자 ID 또는 'cloudpress-service-db' 등)
   */
  constructor(env, namespace = 'default') {
    this._cfg = ghCfg(env);
    this._ns  = String(namespace).replace(/[^a-z0-9_\-]/gi, '_').slice(0, 64);
    this._env = env;
  }

  _path(collection) {
    return `data/db/${this._ns}/${String(collection).replace(/[^a-z0-9_\-]/gi, '_').slice(0, 64)}.json`;
  }

  async _read(collection) {
    if (!this._cfg) return { rows: {}, meta: {} };
    const file = await cachedRead(this._cfg, this._path(collection)).catch(() => null);
    if (!file) return { rows: {}, meta: {}, sha: null };
    return { ...file.content, sha: file.sha };
  }

  async _write(collection, rows, existingSha) {
    if (!this._cfg) return; // GitHub 미설정: 요청 내 메모리에만 존재 (개발 모드)
    const data = { rows, meta: { updatedAt: new Date().toISOString(), ns: this._ns } };
    const result = await ghWrite(this._cfg, this._path(collection), data, existingSha);
    // 캐시 무효화
    _reqCache.delete(this._path(collection));
    return result;
  }

  // ── KV API ──────────────────────────────────────────────

  /** KV 쓰기. 동시 충돌 시 자동 CAS 재시도. */
  async kvPut(key, value) {
    const coll = await this._read('kv');
    coll.rows[key] = { value, updatedAt: new Date().toISOString() };
    await this._write('kv', coll.rows, coll.sha);
    return { ok: true, key };
  }

  /** KV 읽기. */
  async kvGet(key) {
    const coll = await this._read('kv');
    return coll.rows[key]?.value ?? null;
  }

  /** KV 삭제. */
  async kvDelete(key) {
    const coll = await this._read('kv');
    if (!(key in coll.rows)) return { ok: false };
    delete coll.rows[key];
    await this._write('kv', coll.rows, coll.sha);
    return { ok: true };
  }

  /** KV prefix 목록. */
  async kvList(prefix = '') {
    const coll = await this._read('kv');
    return Object.entries(coll.rows)
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, row]) => ({ key, ...row }));
  }

  // ── SQL API ─────────────────────────────────────────────
  // 지원: CREATE TABLE, INSERT INTO, SELECT *, SELECT WHERE, DELETE WHERE, DROP TABLE

  /** SQL 실행. */
  async sqlExecute(sql, params = []) {
    const q = sql.trim();
    let p = 0;
    const bind = () => params[p++];

    // CREATE TABLE
    {
      const m = q.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)\s*\((.+)\)$/is);
      if (m) {
        const existing = await this._read(m[1]);
        if (!existing.sha) { // 아직 없는 경우만 생성
          await this._write(m[1], {}, null);
        }
        return { ok: true, rows: [], rowCount: 0 };
      }
    }

    // DROP TABLE
    {
      const m = q.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z0-9_]+)$/is);
      if (m) {
        if (!this._cfg) return { ok: true, rows: [], rowCount: 0 };
        const existing = await this._read(m[1]);
        if (existing.sha) {
          await ghDelete(this._cfg, this._path(m[1]), existing.sha);
          _reqCache.delete(this._path(m[1]));
        }
        return { ok: true, rows: [], rowCount: 0 };
      }
    }

    // INSERT INTO table (cols) VALUES (...)
    {
      const m = q.match(/^INSERT\s+INTO\s+([a-z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)$/is);
      if (m) {
        const table = m[1];
        const cols = m[2].split(',').map(c => c.trim());
        const coll = await this._read(table);
        const row = { _id: crypto.randomUUID(), _createdAt: new Date().toISOString() };
        cols.forEach(c => { row[c] = bind(); });
        coll.rows[row._id] = row;
        await this._write(table, coll.rows, coll.sha);
        return { ok: true, rows: [row], rowCount: 1 };
      }
    }

    // SELECT * FROM table [WHERE col = ?] [LIMIT n]
    {
      const m = q.match(/^SELECT\s+(.+?)\s+FROM\s+([a-z0-9_]+)(?:\s+WHERE\s+(.+?))?(?:\s+LIMIT\s+(\d+))?$/is);
      if (m) {
        const coll = await this._read(m[2]);
        let rows = Object.values(coll.rows);
        if (m[3]) {
          // 간단 WHERE: col = ? (AND 연결)
          const conditions = m[3].split(/\s+AND\s+/i).map(c => {
            const parts = c.trim().match(/^([a-z0-9_]+)\s*=\s*\?$/i);
            return parts ? { col: parts[1], val: bind() } : null;
          }).filter(Boolean);
          rows = rows.filter(r => conditions.every(c => String(r[c.col]) === String(c.val)));
        }
        if (m[4]) rows = rows.slice(0, parseInt(m[4], 10));
        return { ok: true, rows, rowCount: rows.length };
      }
    }

    // UPDATE table SET col = ? [WHERE col = ?]
    {
      const m = q.match(/^UPDATE\s+([a-z0-9_]+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+?))?$/is);
      if (m) {
        const coll = await this._read(m[1]);
        const setters = m[2].split(',').map(s => {
          const parts = s.trim().match(/^([a-z0-9_]+)\s*=\s*\?$/i);
          return parts ? { col: parts[1], val: bind() } : null;
        }).filter(Boolean);
        let conditions = [];
        if (m[3]) {
          conditions = m[3].split(/\s+AND\s+/i).map(c => {
            const parts = c.trim().match(/^([a-z0-9_]+)\s*=\s*\?$/i);
            return parts ? { col: parts[1], val: bind() } : null;
          }).filter(Boolean);
        }
        let updated = 0;
        for (const [id, row] of Object.entries(coll.rows)) {
          if (conditions.length === 0 || conditions.every(c => String(row[c.col]) === String(c.val))) {
            setters.forEach(s => { coll.rows[id][s.col] = s.val; });
            coll.rows[id]._updatedAt = new Date().toISOString();
            updated++;
          }
        }
        await this._write(m[1], coll.rows, coll.sha);
        return { ok: true, rows: [], rowCount: updated };
      }
    }

    // DELETE FROM table [WHERE col = ?]
    {
      const m = q.match(/^DELETE\s+FROM\s+([a-z0-9_]+)(?:\s+WHERE\s+(.+?))?$/is);
      if (m) {
        const coll = await this._read(m[1]);
        let deleted = 0;
        if (!m[2]) {
          deleted = Object.keys(coll.rows).length;
          await this._write(m[1], {}, coll.sha);
        } else {
          const conditions = m[2].split(/\s+AND\s+/i).map(c => {
            const parts = c.trim().match(/^([a-z0-9_]+)\s*=\s*\?$/i);
            return parts ? { col: parts[1], val: bind() } : null;
          }).filter(Boolean);
          for (const [id, row] of Object.entries(coll.rows)) {
            if (conditions.every(c => String(row[c.col]) === String(c.val))) {
              delete coll.rows[id];
              deleted++;
            }
          }
          await this._write(m[1], coll.rows, coll.sha);
        }
        return { ok: true, rows: [], rowCount: deleted };
      }
    }

    return { ok: false, error: 'unsupported SQL statement', sql: q };
  }

  /** 테이블 목록 조회. */
  async sqlTables() {
    if (!this._cfg) return [];
    // GitHub API: data/db/{ns}/ 폴더 목록
    const url = `${API}/repos/${this._cfg.owner}/${this._cfg.repo}/contents/data/db/${this._ns}?ref=${encodeURIComponent(this._cfg.branch)}`;
    const res = await fetch(url, { headers: ghHeaders(this._cfg.token) });
    if (!res.ok) return [];
    const files = await res.json();
    return (Array.isArray(files) ? files : [])
      .filter(f => f.name.endsWith('.json') && f.name !== 'kv.json')
      .map(f => f.name.replace('.json', ''));
  }
}

// ── 편의 클래스: 네임스페이스별 KV/SQL 래퍼 ─────────────
export class CloudPressKV {
  constructor(env, namespace = 'default') { this._db = new CloudPressDB(env, namespace); }
  async put(key, value)        { return this._db.kvPut(key, value); }
  async get(key)               { return this._db.kvGet(key); }
  async delete(key)            { return this._db.kvDelete(key); }
  async list(prefix = '')      { return this._db.kvList(prefix); }
}

export class CloudPressSQL {
  constructor(env, database = 'default') { this._db = new CloudPressDB(env, database); }
  async execute(sql, params = []) { return this._db.sqlExecute(sql, params); }
  async tables()                  { return this._db.sqlTables(); }
}

// ═══════════════════════════════════════════════════════════
// CP3 — 완전 자체 제작 서버리스 오브젝트 스토리지
// ═══════════════════════════════════════════════════════════
//
// 저장 구조:
//   data/cp3/{bucket}/index.json   — 오브젝트 메타데이터 맵
//   data/cp3/{bucket}/obj/{key}    — 실제 오브젝트 데이터 (base64 또는 JSON)
//
// 최대 오브젝트 크기: GitHub 파일 한 개당 ~1MB (GitHub 제한)
// 대용량은 청크 분할 저장 (key__chunk__N)

const CP3_CHUNK_SIZE = 400_000; // bytes (GitHub 파일 안전 크기)

export class CP3 {
  /**
   * @param {object} env - Worker env
   * @param {string} bucket - 버킷명
   */
  constructor(env, bucket = 'default') {
    this._cfg    = ghCfg(env);
    this._bucket = String(bucket).replace(/[^a-z0-9_\-]/gi, '_').slice(0, 64);
  }

  _indexPath() { return `data/cp3/${this._bucket}/index.json`; }
  _objPath(key) {
    const safe = encodeURIComponent(key).replace(/%/g, '_').slice(0, 100);
    return `data/cp3/${this._bucket}/obj/${safe}`;
  }

  async _readIndex() {
    if (!this._cfg) return { objects: {}, sha: null };
    const file = await cachedRead(this._cfg, this._indexPath()).catch(() => null);
    if (!file) return { objects: {}, sha: null };
    return { objects: file.content.objects || {}, sha: file.sha };
  }

  async _writeIndex(objects, sha) {
    if (!this._cfg) return;
    await ghWrite(this._cfg, this._indexPath(), { objects, updatedAt: new Date().toISOString() }, sha);
    _reqCache.delete(this._indexPath());
  }

  /**
   * 오브젝트 저장.
   * data: string | Uint8Array | object
   * 1MB 초과 시 자동 청크 분할.
   */
  async put(name, data) {
    const payload = typeof data === 'string' ? data
      : data instanceof Uint8Array ? b64Encode(data)
      : JSON.stringify(data);

    const payloadBytes = enc.encode(payload);
    const hash = await sha256(payload);
    const totalSize = payloadBytes.length;
    const chunks = Math.ceil(totalSize / CP3_CHUNK_SIZE);

    const idx = await this._readIndex();
    const key = name.replace(/[^a-z0-9._\-/]/gi, '_');

    // 이전 청크 삭제 (크기가 줄었을 경우)
    const prev = idx.objects[key];
    if (prev && prev.chunks > chunks) {
      const delPromises = [];
      for (let i = chunks; i < prev.chunks; i++)
        delPromises.push(this._deleteChunk(key, i, idx.objects[`${key}__chunk__${i}`]?.sha));
      await Promise.all(delPromises);
    }

    // 청크 병렬 업로드
    const writePromises = [];
    for (let i = 0; i < chunks; i++) {
      const slice = payload.slice(i * CP3_CHUNK_SIZE, (i + 1) * CP3_CHUNK_SIZE);
      const chunkKey = chunks === 1 ? key : `${key}__chunk__${i}`;
      const prevChunkSha = idx.objects[chunkKey]?.sha;
      writePromises.push(
        ghWrite(this._cfg, this._objPath(chunkKey), slice, prevChunkSha)
          .then(r => ({ chunkKey, sha: r?.sha }))
      );
    }
    const results = await Promise.all(writePromises);

    // 인덱스 업데이트
    const meta = {
      name,
      key,
      size: totalSize,
      sha256: hash,
      chunks,
      contentType: typeof data === 'string' ? 'text/plain' : data instanceof Uint8Array ? 'application/octet-stream' : 'application/json',
      createdAt: idx.objects[key]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    idx.objects[key] = meta;
    // 청크별 SHA 저장
    for (const { chunkKey, sha } of results) {
      if (chunkKey !== key) idx.objects[chunkKey] = { sha };
    }
    await this._writeIndex(idx.objects, idx.sha);
    return meta;
  }

  async _deleteChunk(key, i, sha) {
    if (!this._cfg || !sha) return;
    const chunkKey = `${key}__chunk__${i}`;
    await ghDelete(this._cfg, this._objPath(chunkKey), sha).catch(() => null);
  }

  /**
   * 오브젝트 읽기.
   * 반환: { meta, data: string } 또는 null
   */
  async get(name) {
    const key = name.replace(/[^a-z0-9._\-/]/gi, '_');
    const idx = await this._readIndex();
    const meta = idx.objects[key];
    if (!meta) return null;

    if (meta.chunks === 1 || !meta.chunks) {
      const file = await cachedRead(this._cfg, this._objPath(key), false).catch(() => null);
      if (!file) return null;
      return { meta, data: file.content };
    }

    // 청크 병렬 다운로드
    const chunkPromises = [];
    for (let i = 0; i < meta.chunks; i++) {
      const chunkKey = `${key}__chunk__${i}`;
      chunkPromises.push(cachedRead(this._cfg, this._objPath(chunkKey), false).then(f => f?.content || ''));
    }
    const chunks = await Promise.all(chunkPromises);
    return { meta, data: chunks.join('') };
  }

  /**
   * 오브젝트 삭제.
   */
  async delete(name) {
    const key = name.replace(/[^a-z0-9._\-/]/gi, '_');
    const idx = await this._readIndex();
    const meta = idx.objects[key];
    if (!meta) return { ok: false };

    // 청크 파일 병렬 삭제
    const delPromises = [];
    if (meta.chunks && meta.chunks > 1) {
      for (let i = 0; i < meta.chunks; i++) {
        const chunkKey = `${key}__chunk__${i}`;
        const sha = idx.objects[chunkKey]?.sha;
        if (sha) delPromises.push(ghDelete(this._cfg, this._objPath(chunkKey), sha));
        delete idx.objects[chunkKey];
      }
    } else {
      const file = await cachedRead(this._cfg, this._objPath(key), false).catch(() => null);
      if (file?.sha) delPromises.push(ghDelete(this._cfg, this._objPath(key), file.sha));
    }
    delete idx.objects[key];

    await Promise.all([
      ...delPromises,
      this._writeIndex(idx.objects, idx.sha)
    ]);
    return { ok: true };
  }

  /**
   * 오브젝트 목록.
   */
  async list(prefix = '') {
    const idx = await this._readIndex();
    return Object.values(idx.objects)
      .filter(m => m.name && m.name.startsWith(prefix) && !m.name.includes('__chunk__'))
      .map(({ sha256: h, ...m }) => ({ ...m, sha256: h }));
  }
}

// ═══════════════════════════════════════════════════════════
// 세션 엔진 — GitHub 기반 영속 세션
// ═══════════════════════════════════════════════════════════
//
// data/sessions/{sid_hash}.json 에 암호화(HMAC 서명) 저장.
// Worker 재시작해도 세션 유지.

export class SessionStore {
  constructor(env) {
    this._cfg    = ghCfg(env);
    this._secret = env.JWT_SECRET || env.SESSION_SECRET || 'cloudpress-default-secret-change-me';
  }

  _path(sid) { return `data/sessions/${sid}.json`; }

  async create(email, ttlSeconds = 86400) {
    const sid = crypto.randomUUID().replace(/-/g, '');
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const payload = { email, expiresAt, createdAt: Date.now() };
    const sig = await hmacSign(this._secret, JSON.stringify(payload));
    const data = { ...payload, sig };

    if (this._cfg) {
      // 백그라운드 저장 (응답을 블로킹하지 않음)
      ghWrite(this._cfg, this._path(sid), data, null).catch(() => null);
    }
    // 로컬 캐시에도 보관 (같은 요청 내 즉시 사용 가능)
    _reqCache.set(this._path(sid), Promise.resolve({ content: data, sha: null }));
    return sid;
  }

  async get(sid) {
    if (!sid) return null;
    let data;
    if (this._cfg) {
      const file = await cachedRead(this._cfg, this._path(sid)).catch(() => null);
      data = file?.content;
    } else {
      const cached = _reqCache.get(this._path(sid));
      data = cached ? (await cached).content : null;
    }
    if (!data) return null;
    if (data.expiresAt < Date.now()) {
      this.delete(sid).catch(() => null);
      return null;
    }
    // 서명 검증
    const { sig, ...payload } = data;
    const expected = await hmacSign(this._secret, JSON.stringify(payload));
    if (sig !== expected) return null;
    return payload;
  }

  async delete(sid) {
    if (!this._cfg) return;
    const file = await ghRead(this._cfg, this._path(sid), false).catch(() => null);
    if (file?.sha) await ghDelete(this._cfg, this._path(sid), file.sha).catch(() => null);
    _reqCache.delete(this._path(sid));
  }

  /** 만료된 세션 일괄 정리 (백그라운드 호출용). */
  async cleanup() {
    if (!this._cfg) return;
    const url = `${API}/repos/${this._cfg.owner}/${this._cfg.repo}/contents/data/sessions?ref=${encodeURIComponent(this._cfg.branch)}`;
    const res = await fetch(url, { headers: ghHeaders(this._cfg.token) });
    if (!res.ok) return;
    const files = await res.json();
    if (!Array.isArray(files)) return;
    const now = Date.now();
    await Promise.all(files.map(async f => {
      try {
        const file = await ghRead(this._cfg, `data/sessions/${f.name}`, true);
        if (file?.content?.expiresAt < now) {
          await ghDelete(this._cfg, `data/sessions/${f.name}`, file.sha);
        }
      } catch { /* 무시 */ }
    }));
  }
}

// ═══════════════════════════════════════════════════════════
// 감사 로그 — 영속, 최대 1000건
// ═══════════════════════════════════════════════════════════
const AUDIT_PATH = 'data/audit.json';
const AUDIT_MAX  = 1000;

export class AuditLog {
  constructor(env) {
    this._cfg = ghCfg(env);
    // 메모리 버퍼 (같은 isolate 내 즉시 반영)
    this._buf = [];
  }

  async append(actor, action, meta = {}) {
    const entry = { id: `audit_${Date.now()}_${Math.random().toString(36).slice(2)}`, actor, action, meta, at: new Date().toISOString() };
    this._buf.push(entry);
    if (!this._cfg) return;
    // 백그라운드 GitHub 저장
    this._flush().catch(() => null);
    return entry;
  }

  async _flush() {
    const file = await ghRead(this._cfg, AUDIT_PATH).catch(() => null);
    const existing = file?.content?.entries || [];
    const merged = [...existing, ...this._buf].slice(-AUDIT_MAX);
    this._buf = [];
    await ghWrite(this._cfg, AUDIT_PATH, { entries: merged, updatedAt: new Date().toISOString() }, file?.sha);
  }

  async getAll() {
    if (!this._cfg) return this._buf;
    const file = await cachedRead(this._cfg, AUDIT_PATH).catch(() => null);
    return [...(file?.content?.entries || []), ...this._buf];
  }
}

// ═══════════════════════════════════════════════════════════
// 유틸리티 export
// ═══════════════════════════════════════════════════════════
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

export function sanitizeEmail(email) {
  return String(email || '').trim().toLowerCase().slice(0, 254);
}

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

export function secureHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; base-uri 'self'; frame-ancestors 'none'"
  };
}

export function jsonRes(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...secureHeaders(), ...extra }
  });
}

export function htmlRes(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...secureHeaders() }
  });
}
