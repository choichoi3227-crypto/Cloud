// github-store.js
// ------------------------------------------------------------------
// CloudPress의 영속성 "서브" 레이어.
// Cloudflare KV/D1/R2/Durable Objects를 전혀 사용하지 않고,
// GitHub repo(Contents API)를 디스크처럼 사용해 JSON 스냅샷을 저장/복원한다.
//
// 구조:
//   메인  : Worker 메모리(Map, 100% 자체 제작 KV/SQL 엔진) — 매 요청 즉시 반영
//   서브  : GitHub repo의 data/snapshot.json — 메모리 내용을 비동기로 백업
//           Worker(isolate)가 새로 뜰 때 이 파일을 읽어 메모리를 복원
//
// 필요한 Worker secret (wrangler secret put 으로 등록, 코드에 절대 넣지 않음):
//   GITHUB_OWNER  - 예: choichoi3227-crypto
//   GITHUB_REPO   - 예: Cloud
//   GITHUB_TOKEN  - GitHub Personal Access Token (repo contents 권한)
//   GITHUB_BRANCH - 선택, 기본값 main
// ------------------------------------------------------------------

const SNAPSHOT_PATH = 'data/snapshot.json';
const API_ROOT = 'https://api.github.com';

function configFrom(env = {}) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;
  const branch = env.GITHUB_BRANCH || 'main';
  if (!owner || !repo || !token) return null;
  return { owner, repo, token, branch };
}

function headersFor(token) {
  return {
    'authorization': `Bearer ${token}`,
    'accept': 'application/vnd.github+json',
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'cloudpress-self-built-storage'
  };
}

// Workers 런타임에는 Buffer가 없으므로 직접 base64 인코딩/디코딩을 구현한다
// (UTF-8 한글이 섞인 JSON도 깨지지 않도록 TextEncoder/TextDecoder 기반으로 처리).
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const cleaned = b64.replace(/\n/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// 현재 파일의 sha(없으면 null)를 조회한다. 새 파일 생성 시에는 sha가 필요 없다.
async function fetchExistingSha(cfg) {
  const url = `${API_ROOT}/repos/${cfg.owner}/${cfg.repo}/contents/${SNAPSHOT_PATH}?ref=${encodeURIComponent(cfg.branch)}`;
  const res = await fetch(url, { headers: headersFor(cfg.token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github sha lookup failed: ${res.status}`);
  const data = await res.json();
  return data.sha || null;
}

// GitHub repo의 data/snapshot.json을 읽어 JS 객체로 반환한다. 없으면 null.
export async function loadSnapshot(env = {}) {
  const cfg = configFrom(env);
  if (!cfg) return { ok: false, reason: 'not_configured' };
  try {
    const url = `${API_ROOT}/repos/${cfg.owner}/${cfg.repo}/contents/${SNAPSHOT_PATH}?ref=${encodeURIComponent(cfg.branch)}`;
    const res = await fetch(url, { headers: headersFor(cfg.token) });
    if (res.status === 404) return { ok: true, data: null }; // 아직 백업 파일이 없는 첫 부팅
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const file = await res.json();
    const text = base64ToUtf8(file.content || '');
    const data = JSON.parse(text);
    return { ok: true, data, sha: file.sha };
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err) };
  }
}

// JS 객체를 data/snapshot.json에 commit 한다. last-write-wins:
// sha 충돌(409/422)이 나면 최신 sha를 다시 받아 한 번 더 시도한다.
export async function saveSnapshot(env = {}, dataObject, attempt = 0) {
  const cfg = configFrom(env);
  if (!cfg) return { ok: false, reason: 'not_configured' };
  try {
    const sha = await fetchExistingSha(cfg).catch(() => null);
    const body = {
      message: `cloudpress data sync ${new Date().toISOString()}`,
      content: utf8ToBase64(JSON.stringify(dataObject, null, 2)),
      branch: cfg.branch,
      ...(sha ? { sha } : {})
    };
    const url = `${API_ROOT}/repos/${cfg.owner}/${cfg.repo}/contents/${SNAPSHOT_PATH}`;
    const res = await fetch(url, { method: 'PUT', headers: headersFor(cfg.token), body: JSON.stringify(body) });
    if (res.ok) return { ok: true };
    // sha 충돌(다른 isolate가 그 사이 먼저 커밋함) → 한 번만 재시도
    if ((res.status === 409 || res.status === 422) && attempt < 2) {
      return saveSnapshot(env, dataObject, attempt + 1);
    }
    const errText = await res.text().catch(() => '');
    return { ok: false, reason: `http_${res.status}`, detail: errText.slice(0, 300) };
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err) };
  }
}

export function githubConfigured(env = {}) {
  return Boolean(configFrom(env));
}
