import { catalog, store, json, html, sha256, uid, body, sanitizeEmail, publicUser, priceOf, requireUser, audit, CloudPressKV, CloudPressSQL, CP3 } from './platform.js';

const routeMap = {
  '/':'/bridge/index.html','/index':'/bridge/index.html','/feature':'/bridge/feature.html','/about':'/bridge/about.html','/products':'/bridge/products.html','/notice':'/bridge/notice.html',
  '/dashboard':'/console/dashboard.html','/instances':'/console/instances.html','/instance-detail':'/console/instance-detail.html','/payments':'/console/payments.html','/billing':'/console/billing.html','/accounts':'/console/accounts.html','/admin':'/admin/index.html',
  '/login':'/sso/login.html','/signup':'/sso/signup.html','/lost-password':'/sso/lost-password.html'
};
export { catalog };
export default { async fetch(req, env){ const url=new URL(req.url); if(url.pathname.startsWith('/api/')) return api(req,env,url); const page=routeMap[url.pathname] || (url.pathname.includes('/cart/') ? url.pathname : null); if(page) return html(shell(page)); return env.ASSETS ? env.ASSETS.fetch(req) : html(shell('/bridge/index.html')); }};
async function api(req,env,url){
  if(url.pathname==='/api/health') return json({ok:true, service:'cloudpress', targetAvailability:'99.99%', durableObjects:false, time:new Date().toISOString()});
  if(url.pathname==='/api/products') return json({products:catalog});
  if(url.pathname==='/api/auth/signup' && req.method==='POST') return signup(req,env);
  if(url.pathname==='/api/auth/login' && req.method==='POST') return login(req,env);
  if(url.pathname==='/api/auth/logout' && req.method==='POST') return json({ok:true},200,{'set-cookie':'cp_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'});
  if(url.pathname==='/api/auth/lost-password' && req.method==='POST') return lostPassword(req);
  const gate=await requireUser(req); if(gate.error) return gate.error; const user=gate.user;
  if(url.pathname==='/api/me') return json({user:publicUser(user)});
  if(url.pathname==='/api/orders' && req.method==='POST') return createOrder(req,user);
  if(url.pathname==='/api/instances' && req.method==='GET') return json({instances:[...store.instances.values()].filter(i=>i.userId===user.id)});
  if(url.pathname==='/api/instances' && req.method==='POST') return createInstance(req,user);
  if(url.pathname==='/api/cloudpressdb/kv' && req.method==='POST') return kvWrite(req,user);
  if(url.pathname==='/api/cloudpressdb/sql' && req.method==='POST') return sqlExec(req,user);
  if(url.pathname==='/api/cp3/objects' && req.method==='POST') return cp3Put(req,user);
  if(url.pathname==='/api/cp3/objects' && req.method==='GET') return json({objects:await new CP3(user.id).list()});
  if(url.pathname.startsWith('/api/admin/')) return admin(url,user);
  return json({error:'not found'},404);
}
async function signup(req,env){const b=await body(req); for(const f of ['email','name','address','password']) if(!b[f]) return json({error:`${f} is required`},400); const email=sanitizeEmail(b.email); if(store.users.has(email)) return json({error:'email already exists'},409); const user={id:uid('user'),email,name:String(b.name),address:String(b.address),passwordHash:await sha256(String(b.password)),roles:email===sanitizeEmail(env.ADMIN_BOOTSTRAP_EMAIL)?['admin']:['user'],providers:['email'],createdAt:new Date().toISOString()}; store.users.set(email,user); audit(user.id,'user.signup'); return json({user:publicUser(user)},201)}
async function login(req,env){const b=await body(req); const email=sanitizeEmail(b.email); const user=store.users.get(email); if(!user || user.passwordHash!==await sha256(String(b.password||''))) return json({error:'invalid credentials'},401); const sid=uid('sess'); const ttl=Number(env.SESSION_TTL_SECONDS||86400); store.sessions.set(sid,{email,expiresAt:Date.now()+ttl*1000}); audit(user.id,'auth.login'); return json({user:publicUser(user)},200,{'set-cookie':`cp_session=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttl}`})}
async function lostPassword(req){const b=await body(req); const email=sanitizeEmail(b.email); const user=store.users.get(email); if(user){const temp=crypto.randomUUID().replaceAll('-','').slice(0,16); user.passwordHash=await sha256(temp); audit(user.id,'auth.password_reset_requested',{provider:'firebase-email'}); return json({ok:true, delivery:'firebase-email', developmentTempPassword:temp})} return json({ok:true})}
async function createOrder(req,user){const b=await body(req); const amount=priceOf(b); if(amount===null) return json({error:'unknown product'},400); const order={id:uid('bill'),userId:user.id,product:b.product,plan:b.plan||null,gb:b.gb||null,amountUsd:amount,status:'pending',cartPath:`/${b.product}/cart/`,createdAt:new Date().toISOString()}; order.cartPath+=order.id; store.orders.set(order.id,order); audit(user.id,'order.create',{orderId:order.id,product:b.product}); return json({order,cartPath:order.cartPath},201)}
async function createInstance(req,user){const b=await body(req); const type=b.type||'wordpress'; const instance={id:uid('inst'),userId:user.id,type,name:b.name||`${type}-site`,status:'provisioning',network:{cdn:'cloudflare',dns:'automatic'},runtime:type==='wordpress'||type==='php'?'php-wasm':'static',database:type==='wordpress'?'CloudPressDB wordpress-nosql':null,storage:type==='wordpress'?'CP3 separate product':null,createdAt:new Date().toISOString()}; store.instances.set(instance.id,instance); audit(user.id,'instance.create',{instanceId:instance.id}); return json({instance},201)}
async function kvWrite(req,user){const b=await body(req); if(!b.key) return json({error:'key is required'},400); const kv=new CloudPressKV(user.id); await kv.put(b.key,b.value); return json({ok:true,key:b.key})}
async function sqlExec(req,user){const b=await body(req); const sql=new CloudPressSQL(user.id); return json(sql.execute(String(b.sql||''),Array.isArray(b.params)?b.params:[]))}
async function cp3Put(req,user){const b=await body(req); if(!b.name) return json({error:'name is required'},400); const meta=await new CP3(user.id).put(b.name,b.data||''); const {payload,...safe}=meta; return json({object:safe},201)}
function admin(url,user){if(!user.roles.includes('admin')) return json({error:'admin required'},403); return json({users:[...store.users.values()].map(publicUser),orders:[...store.orders.values()],instances:[...store.instances.values()],audit:store.audit,notices:[...store.notices.values()]})}
function shell(page){return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>클라우드프레스</title><link rel="stylesheet" href="/_next/static/css/landing-sso001.css"><link rel="stylesheet" href="/_next/static/css/landing-sso002.css"><link rel="stylesheet" href="/_next/static/css/landing-sso003.css"><link rel="stylesheet" href="/_next/static/css/dashboard001.css"><link rel="stylesheet" href="/_next/static/css/dashboard002.css"><link rel="stylesheet" href="/_next/static/css/dashboard003.css"><link rel="stylesheet" href="/app.css"></head><body><div id="app" data-page="${page}"></div><script src="/app.js"></script></body></html>`}
