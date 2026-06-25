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
export function secureHeaders(){return {'x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'strict-origin-when-cross-origin','strict-transport-security':'max-age=31536000; includeSubDomains; preload','permissions-policy':'camera=(), microphone=(), geolocation=()','content-security-policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'"}}
export function json(data,status=200,headers={}){return new Response(JSON.stringify(data,null,2),{status,headers:{'content-type':'application/json; charset=utf-8',...secureHeaders(),...headers}})}
export function html(body,status=200){return new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8',...secureHeaders()}})}
export async function sha256(value){const bytes=await crypto.subtle.digest('SHA-256',text.encode(value));return [...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('')}
export function uid(prefix){return `${prefix}_${crypto.randomUUID()}`}
export async function body(req){try{return await req.json()}catch{return {}}}
export function sanitizeEmail(email){return String(email||'').trim().toLowerCase()}
export function publicUser(user){if(!user)return null; const {passwordHash,...safe}=user; return safe}
export function priceOf(input){const p=catalog[input.product]; if(!p) return null; if(input.product==='wordpress') return p.plans[input.plan] || p.plans.lite; if(input.product==='cp3') return p.basePrice + Math.max(0, Number(input.gb||p.includedGb)-p.includedGb)*p.extraPerGb; return p.price || 0}
export async function currentUser(req){const cookie=req.headers.get('cookie')||''; const sid=(cookie.match(/(?:^|; )cp_session=([^;]+)/)||[])[1]; const session=sid&&store.sessions.get(sid); if(!session||session.expiresAt<Date.now())return null; return store.users.get(session.email)}
export async function requireUser(req){const user=await currentUser(req); if(!user) return {error:json({error:'authentication required'},401)}; return {user}}
export function audit(actor,action,meta={}){store.audit.push({id:uid('audit'),actor,action,meta,at:new Date().toISOString()})}
export class CloudPressKV { constructor(namespace='default'){this.namespace=namespace} key(k){return `${this.namespace}:${k}`} async put(k,v){store.kv.set(this.key(k),{value:v,updatedAt:new Date().toISOString()});return true} async get(k){return store.kv.get(this.key(k))?.value ?? null} async delete(k){return store.kv.delete(this.key(k))} async list(prefix=''){return [...store.kv.entries()].filter(([k])=>k.startsWith(this.key(prefix))).map(([key,row])=>({key:key.slice(this.namespace.length+1),...row}))}}
export class CloudPressSQL { constructor(database='default'){this.database=database;if(!store.tables.has(database))store.tables.set(database,new Map())} db(){return store.tables.get(this.database)} execute(sql,params=[]){const q=sql.trim(); const create=q.match(/^create table ([a-z0-9_]+) \((.+)\)$/i); if(create){this.db().set(create[1],[]);return {ok:true,rows:[]}} const insert=q.match(/^insert into ([a-z0-9_]+) \((.+)\) values \((.+)\)$/i); if(insert){const cols=insert[2].split(',').map(x=>x.trim()); const row=Object.fromEntries(cols.map((c,i)=>[c,params[i]])); this.db().get(insert[1])?.push(row); return {ok:true,rows:[row]}} const select=q.match(/^select \* from ([a-z0-9_]+)$/i); if(select)return {ok:true,rows:[...(this.db().get(select[1])||[])]}; return {ok:false,error:'unsupported sql statement'}}}
export class CP3 { constructor(bucket='default'){this.bucket=bucket} key(k){return `${this.bucket}:${k}`} async put(name,data){const payload=typeof data==='string'?data:JSON.stringify(data); store.objects.set(this.key(name),{name,size:new Blob([payload]).size,sha256:await sha256(payload),payload,createdAt:new Date().toISOString()}); return store.objects.get(this.key(name))} async get(name){return store.objects.get(this.key(name))||null} async list(){return [...store.objects.values()].filter(x=>store.objects.has(this.key(x.name))).map(({payload,...m})=>m)}}

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
