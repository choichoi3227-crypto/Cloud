import { loadSnapshot, saveSnapshot, githubConfigured } from './github-store.js';

const text = new TextEncoder();
export const catalog = Object.freeze({
  wordpress: { slug: 'wordpress', name: '워드프레스 호스팅', plans: { lite: 14, standard: 29, intelligent: 42, imperial: 59, duplex: 76 }, common: ['무제한 트래픽', 'Cloudflare CDN 무료 제공', '자동 DNS 설정', '자동 FTP 기능'], limits: { lite: '개인 블로그/소형 사이트', standard: '성장형 사이트', intelligent: '고트래픽 최적화', imperial: '비즈니스 고가용성', duplex: '멀티 사이트 운영' }, stack: ['php-wasm', 'CloudPressDB NoSQL', 'CP3 isolated storage'] },
  cloudpressdb: { slug: 'cloudpressdb', name: 'CloudPressDB', price: 10, types: { 'wordpress-nosql': '워드프레스 스키마에 맞춘 Key-Value NoSQL', 'general-nosql': '범용 서버리스 Key-Value NoSQL', 'general-sql': '자체 SQL 실행기 기반 서버리스 SQL' } },
  cp3: { slug: 'cp3', name: 'CP3', basePrice: 10, includedGb: 50, extraPerGb: 0.5, policy: 'R2/S3/외부 스토리지 미사용 자체 네임스페이스' },
  static: { slug: 'static', name: '정적 사이트', price: 0, stack: ['HTML', 'CSS', 'JS', 'edge cache'] },
  php: { slug: 'php', name: 'PHP 사이트', price: 12, stack: ['php-wasm', 'isolated runtime'] }
});
export function createStore(){return {users:new Map(),sessions:new Map(),orders:new Map(),instances:new Map(),notices:new Map(),kv:new Map(),tables:new Map(),objects:new Map(),audit:[]}}
export const store = globalThis.__CLOUDPRESS_STORE__ || (globalThis.__CLOUDPRESS_STORE__ = createStore());

// ------------------------------------------------------------------
// 영속성 동기화 레이어 (메인: 메모리 Map, 서브: GitHub repo JSON 스냅샷)
// 100% 자체 제작 로직. Cloudflare KV/D1/R2/Durable Objects 미사용.
// ------------------------------------------------------------------
const SYNC_STATE_KEY = '__CLOUDPRESS_SYNC_STATE__';
function syncState(){
  if(!globalThis[SYNC_STATE_KEY]) globalThis[SYNC_STATE_KEY] = { restored:false, restoring:null, pendingSave:null, lastEnv:null, waitUntil:null };
  return globalThis[SYNC_STATE_KEY];
}
// 매 요청 시작 시 worker.js가 env와 ctx.waitUntil을 등록해 둔다.
// 이렇게 해야 KV/SQL/CP3 같은 깊은 곳의 쓰기 로직에서도 별도 인자 없이
// "지금 요청의 env/waitUntil"을 참조해 GitHub 백업을 예약할 수 있다.
export function registerRequestContext(env, waitUntil){
  const state = syncState();
  state.lastEnv = env;
  state.waitUntil = waitUntil || null;
}

// Map 기반 store(세션 제외 — 세션은 휘발성으로 두는 게 보안상 정상)를
// JSON으로 백업/복원 가능한 평범한 객체로 직렬화한다.
export function serializeStore(s = store){
  return {
    users: [...s.users.entries()],
    orders: [...s.orders.entries()],
    instances: [...s.instances.entries()],
    notices: [...s.notices.entries()],
    kv: [...s.kv.entries()],
    tables: [...s.tables.entries()].map(([db, tbl]) => [db, [...tbl.entries()]]),
    objects: [...s.objects.entries()],
    audit: s.audit,
    savedAt: new Date().toISOString()
  };
}

// 직렬화된 JSON 스냅샷을 받아 store(Map 구조)에 그대로 덮어쓴다.
// 단, 메모리에 이미 들어온 데이터(예: 같은 요청 처리 중 생성된 사용자)는
// 보존하기 위해 "병합"이 아니라 "복원이 아직 안 됐을 때만" 호출한다.
export function hydrateStore(snapshot, s = store){
  if(!snapshot) return s;
  if(snapshot.users) s.users = new Map(snapshot.users);
  if(snapshot.orders) s.orders = new Map(snapshot.orders);
  if(snapshot.instances) s.instances = new Map(snapshot.instances);
  if(snapshot.notices) s.notices = new Map(snapshot.notices);
  if(snapshot.kv) s.kv = new Map(snapshot.kv);
  if(snapshot.tables) s.tables = new Map(snapshot.tables.map(([db, rows]) => [db, new Map(rows)]));
  if(snapshot.objects) s.objects = new Map(snapshot.objects);
  if(snapshot.audit) s.audit = snapshot.audit;
  return s;
}

// Worker(isolate)가 새로 떠서 메모리가 비어있는 첫 요청에서 한 번만 GitHub에서 복원한다.
// 동시에 여러 요청이 들어와도 복원은 단 한 번만 실행되도록 in-flight promise를 공유한다.
export async function ensureHydrated(env = {}){
  const state = syncState();
  state.lastEnv = env;
  if(state.restored) return;
  if(state.restoring){ await state.restoring; return; }
  if(!githubConfigured(env)){ state.restored = true; return; } // GitHub 미설정이면 메모리만 사용
  state.restoring = (async () => {
    const result = await loadSnapshot(env);
    if(result.ok && result.data){ hydrateStore(result.data); }
    state.restored = true;
  })();
  await state.restoring;
}

// 메모리에 변경이 생길 때마다 호출. GitHub 쓰기는 응답을 막지 않도록 백그라운드로 보낸다.
// 같은 isolate에서 짧은 시간에 여러 쓰기가 몰리면 마지막 한 번만 보내도록 합쳐(debounce) 불필요한 API 호출을 줄인다.
export function scheduleSync(env, waitUntil){
  const state = syncState();
  const useEnv = env || state.lastEnv || {};
  const useWaitUntil = waitUntil || state.waitUntil;
  if(!githubConfigured(useEnv)) return;
  if(state.pendingSave) return; // 이미 예약된 동기화가 있으면 중복 예약하지 않음(곧 최신 상태를 통째로 올림)
  const task = (async () => {
    await new Promise(r => setTimeout(r, 50)); // 같은 요청 내 여러 쓰기를 한 번에 모으기 위한 짧은 대기
    state.pendingSave = null;
    const snapshot = serializeStore();
    await saveSnapshot(useEnv, snapshot);
  })();
  state.pendingSave = task;
  if(typeof useWaitUntil === 'function') useWaitUntil(task);
}

export function githubSyncStatus(env = {}){
  const state = syncState();
  return {
    configured: githubConfigured(env || state.lastEnv || {}),
    restored: state.restored,
    syncing: Boolean(state.pendingSave)
  };
}

export function secureHeaders(){return {'x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'strict-origin-when-cross-origin','strict-transport-security':'max-age=31536000; includeSubDomains; preload','permissions-policy':'camera=(), microphone=(), geolocation=()','content-security-policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'"}}
export function json(data,status=200,headers={}){return new Response(JSON.stringify(data,null,2),{status,headers:{'content-type':'application/json; charset=utf-8',...secureHeaders(),...headers}})}
export function html(body,status=200){return new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8',...secureHeaders()}})}
export async function sha256(value){const bytes=await crypto.subtle.digest('SHA-256',text.encode(value));return [...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('')}
export function uid(prefix){return `${prefix}_${crypto.randomUUID()}`}
export async function body(req){try{return await req.json()}catch{return {}}}
export function sanitizeEmail(email){return String(email||'').trim().toLowerCase()}
export function publicUser(user){if(!user)return null; const {passwordHash,...safe}=user; return safe}
export function priceOf(input){const p=catalog[input.product]; if(!p) return null; if(input.product==='wordpress') return p.plans[input.plan] || p.plans.lite; if(input.product==='cp3') return p.basePrice + Math.max(0, Number(input.gb||p.includedGb)-p.includedGb)*p.extraPerGb; return p.price || 0}
export async function currentUser(req, env={}){const cookie=req.headers.get('cookie')||''; const sid=(cookie.match(/(?:^|; )cp_session=([^;]+)/)||[])[1]; const session=sid&&store.sessions.get(sid); if(!session||session.expiresAt<Date.now())return null; const user=store.users.get(session.email); return ensureAdminRole(user, env)}
export async function requireUser(req, env={}){const user=await currentUser(req, env); if(!user) return {error:json({error:'authentication required'},401)}; return {user}}
export function audit(actor,action,meta={}){store.audit.push({id:uid('audit'),actor,action,meta,at:new Date().toISOString()});scheduleSync()}
export class CloudPressKV { constructor(namespace='default'){this.namespace=namespace} key(k){return `${this.namespace}:${k}`} async put(k,v){store.kv.set(this.key(k),{value:v,updatedAt:new Date().toISOString()});scheduleSync();return true} async get(k){return store.kv.get(this.key(k))?.value ?? null} async delete(k){const ok=store.kv.delete(this.key(k));if(ok)scheduleSync();return ok} async list(prefix=''){return [...store.kv.entries()].filter(([k])=>k.startsWith(this.key(prefix))).map(([key,row])=>({key:key.slice(this.namespace.length+1),...row}))}}
export class CloudPressSQL { constructor(database='default'){this.database=database;if(!store.tables.has(database))store.tables.set(database,new Map())} db(){return store.tables.get(this.database)} execute(sql,params=[]){const q=sql.trim(); const create=q.match(/^create table ([a-z0-9_]+) \((.+)\)$/i); if(create){this.db().set(create[1],[]);scheduleSync();return {ok:true,rows:[]}} const insert=q.match(/^insert into ([a-z0-9_]+) \((.+)\) values \((.+)\)$/i); if(insert){const cols=insert[2].split(',').map(x=>x.trim()); const row=Object.fromEntries(cols.map((c,i)=>[c,params[i]])); this.db().get(insert[1])?.push(row); scheduleSync(); return {ok:true,rows:[row]}} const select=q.match(/^select \* from ([a-z0-9_]+)$/i); if(select)return {ok:true,rows:[...(this.db().get(select[1])||[])]}; return {ok:false,error:'unsupported sql statement'}}}
export class CP3 { constructor(bucket='default'){this.bucket=bucket} key(k){return `${this.bucket}:${k}`} async put(name,data){const payload=typeof data==='string'?data:JSON.stringify(data); store.objects.set(this.key(name),{name,size:new Blob([payload]).size,sha256:await sha256(payload),payload,createdAt:new Date().toISOString()}); scheduleSync(); return store.objects.get(this.key(name))} async get(name){return store.objects.get(this.key(name))||null} async list(){return [...store.objects.values()].filter(x=>store.objects.has(this.key(x.name))).map(({payload,...m})=>m)}}

export const serviceNamespaces = Object.freeze({ database: 'cloudpress-service-db', storage: 'cloudpress-service-cp3', sql: 'cloudpress-service-sql' });
export async function ensureServicePlatform(){
  const kv = new CloudPressKV(serviceNamespaces.database);
  const configured = await kv.get('site:config');
  if(!configured){
    await kv.put('site:config',{name:'클라우드프레스',database:'CloudPressDB',storage:'CP3',capacity:'unlimited',createdAt:new Date().toISOString()});
    await kv.put('runtime:domains',{bridge:'bridge.{domain}',console:'bridge-console.{domain}',sso:'sso.{domain}'});
    const sql = new CloudPressSQL(serviceNamespaces.sql);
    sql.execute('create table service_events (id,type)');
    sql.execute('insert into service_events (id,type) values (?,?)',[uid('evt'),'platform.bootstrap']);
    await new CP3(serviceNamespaces.storage).put('service/README.json',{owner:'cloudpress-service',capacity:'unlimited',purpose:'service-site-assets-and-operational-metadata'});
  }
  return {kv, sql:new CloudPressSQL(serviceNamespaces.sql), storage:new CP3(serviceNamespaces.storage)};
}
export async function serviceSnapshot(){
  const platform = await ensureServicePlatform();
  return {config:await platform.kv.get('site:config'), domains:await platform.kv.get('runtime:domains'), kvItems:await platform.kv.list(), sqlEvents:platform.sql.execute('select * from service_events').rows, storageObjects:await platform.storage.list()};
}
export function isAdmin(user){return Boolean(user?.roles?.includes('admin'))}
export function adminEmailOf(env={}){return sanitizeEmail(env.ADMIN_EMAIL || env.ADMIN_BOOTSTRAP_EMAIL || '')}
// secret 변수(ADMIN_EMAIL, 구버전 호환: ADMIN_BOOTSTRAP_EMAIL)와 이메일이 일치하면
// 가입 시점뿐 아니라 매 로그인 시점에도 해당 사용자가 항상 admin 역할을 갖도록 보장한다.
export function ensureAdminRole(user, env={}){
  if(!user) return user;
  const adminEmail = adminEmailOf(env);
  if(adminEmail && user.email === adminEmail && !user.roles.includes('admin')){
    user.roles = [...user.roles, 'admin'];
  }
  return user;
}
