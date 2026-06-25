import { catalog, store, json, html, sha256, uid, body, sanitizeEmail, publicUser, priceOf, requireUser, audit, CloudPressKV, CloudPressSQL, CP3, ensureServicePlatform, serviceSnapshot, isAdmin, serviceNamespaces } from './platform.js';

const bridgeRoutes = new Set(['/', '/index', '/feature', '/about', '/products', '/notice']);
const consoleRoutes = new Set(['/dashboard', '/instances', '/instance-detail', '/payments', '/billing', '/accounts', '/admin', '/admin/db', '/admin/storage', '/admin/users', '/admin/orders', '/admin/settings']);
const ssoRoutes = new Set(['/login', '/signup', '/lost-password']);
const pageMap = {
  '/':'/bridge/index.html','/index':'/bridge/index.html','/feature':'/bridge/feature.html','/about':'/bridge/about.html','/products':'/bridge/products.html','/notice':'/bridge/notice.html',
  '/dashboard':'/console/dashboard.html','/instances':'/console/instances.html','/instance-detail':'/console/instance-detail.html','/payments':'/console/payments.html','/billing':'/console/billing.html','/accounts':'/console/accounts.html','/admin':'/admin/index.html','/admin/db':'/admin/db.html','/admin/storage':'/admin/storage.html','/admin/users':'/admin/users.html','/admin/orders':'/admin/orders.html','/admin/settings':'/admin/settings.html',
  '/login':'/sso/login.html','/signup':'/sso/signup.html','/lost-password':'/sso/lost-password.html'
};
export { catalog };
export default { async fetch(req, env){
  await ensureServicePlatform();
  const url=new URL(req.url); const scope=domainScope(url.hostname, env);
  if(url.pathname.startsWith('/api/')) return api(req,env,url,scope);
  const page=resolvePage(url, scope); if(page) return html(shell(page));
  if(isKnownPagePath(url.pathname)) return notFound(scope, url.pathname);
  return env.ASSETS ? env.ASSETS.fetch(req) : notFound(scope, url.pathname);
}};
function domainScope(hostname, env={}){const h=hostname.toLowerCase(); const root=String(env.PRIMARY_DOMAIN||'').toLowerCase(); if(h==='localhost'||h==='127.0.0.1'||h.endsWith('.workers.dev')) return 'dev'; if(h.startsWith('bridge-console.')) return 'console'; if(h.startsWith('sso.')) return 'sso'; if(h.startsWith('bridge.')) return 'bridge'; if(root && h===`bridge-console.${root}`) return 'console'; if(root && h===`sso.${root}`) return 'sso'; if(root && h===`bridge.${root}`) return 'bridge'; return 'unknown'}
function isKnownPagePath(path){return bridgeRoutes.has(path)||consoleRoutes.has(path)||ssoRoutes.has(path)||path.includes('/cart/')||path.startsWith('/products/')}
function resolvePage(url,scope){const path=url.pathname; if(scope==='dev'){if(pageMap[path]) return pageMap[path]; if(path.includes('/cart/')) return path; if(path.startsWith('/products/')) return '/bridge/products.html'; return null} if(scope==='bridge'){if(bridgeRoutes.has(path)) return pageMap[path]; if(path.includes('/cart/')||path.startsWith('/products/')) return path; return null} if(scope==='console'&&consoleRoutes.has(path)) return pageMap[path]; if(scope==='sso'&&ssoRoutes.has(path)) return pageMap[path]; return null}
function notFound(scope,path){return html(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 - 클라우드프레스</title><link rel="stylesheet" href="/app.css"></head><body><section class="hero"><h1>404</h1><p>이 페이지는 현재 서브도메인(${scope})에서 사용할 수 없습니다: ${path}</p><a class="btn primary" href="/index">bridge 홈</a></section></body></html>`,404)}
async function api(req,env,url,scope){
  if(url.pathname==='/api/health') return json({ok:true, service:'cloudpress', scope, targetAvailability:'99.99%', durableObjects:false, time:new Date().toISOString()});
  if(url.pathname==='/api/routes') return json({domains:{bridge:[...bridgeRoutes], console:[...consoleRoutes], sso:[...ssoRoutes]}, rule:'wrong subdomain returns 404 for page routes'});
  if(url.pathname==='/api/service-platform') return json({service:await serviceSnapshot(), namespaces:serviceNamespaces});
  if(url.pathname==='/api/products') return json({products:catalog});
  if(url.pathname.startsWith('/api/products/')) {const slug=url.pathname.split('/').pop(); return catalog[slug]?json({product:catalog[slug]}):json({error:'product not found'},404);}
  if(url.pathname==='/api/notices' && req.method==='GET') return json({notices:seedNotices()});
  if(url.pathname.startsWith('/api/auth/') && scope!=='sso' && scope!=='dev') return json({error:'auth API is only available on sso.{domain}'},404);
  if(url.pathname==='/api/auth/signup' && req.method==='POST') return signup(req,env);
  if(url.pathname==='/api/auth/login' && req.method==='POST') return login(req,env);
  if(url.pathname==='/api/auth/logout' && req.method==='POST') return json({ok:true},200,{'set-cookie':'cp_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'});
  if(url.pathname==='/api/auth/lost-password' && req.method==='POST') return lostPassword(req);
  const gate=await requireUser(req); if(gate.error) return gate.error; const user=gate.user;
  if(url.pathname==='/api/me') return json({user:publicUser(user)});
  if(url.pathname==='/api/notices' && req.method==='POST') return createNotice(req,user);
  if(url.pathname==='/api/orders' && req.method==='GET') return json({orders:[...store.orders.values()].filter(o=>o.userId===user.id)});
  if(url.pathname.startsWith('/api/orders/') && req.method==='GET') return orderDetail(url,user);
  if(url.pathname==='/api/orders' && req.method==='POST') return createOrder(req,user);
  if(url.pathname==='/api/billing') return json({billing:billingFor(user)});
  if(url.pathname==='/api/payments' && req.method==='GET') return json({payments:[...store.orders.values()].filter(o=>o.userId===user.id).map(o=>({id:o.id,amountUsd:o.amountUsd,status:o.status,createdAt:o.createdAt}))});
  if(url.pathname==='/api/accounts' && req.method==='PATCH') return updateAccount(req,user);
  if(url.pathname==='/api/instances' && req.method==='GET') return json({instances:[...store.instances.values()].filter(i=>i.userId===user.id)});
  if(url.pathname==='/api/instances' && req.method==='POST') return createInstance(req,user);
  if(url.pathname.startsWith('/api/instances/') && req.method==='GET') return instanceDetail(url,user);
  if(url.pathname==='/api/cloudpressdb/kv' && req.method==='GET') return json({items:await new CloudPressKV(user.id).list()});
  if(url.pathname==='/api/cloudpressdb/kv' && req.method==='POST') return kvWrite(req,user);
  if(url.pathname==='/api/cloudpressdb/sql' && req.method==='POST') return sqlExec(req,user);
  if(url.pathname==='/api/cp3/objects' && req.method==='POST') return cp3Put(req,user);
  if(url.pathname==='/api/cp3/objects' && req.method==='GET') return json({objects:await new CP3(user.id).list()});
  if(url.pathname.startsWith('/api/admin/')) return admin(url,req,user);
  return json({error:'not found'},404);
}
function cookieDomain(env={}){return env.COOKIE_DOMAIN ? `; Domain=${env.COOKIE_DOMAIN}` : ''}
function seedNotices(){if(!store.notices.size){const n={id:'notice_bootstrap',title:'CloudPress platform initialized',body:'도메인별 페이지 라우팅과 핵심 API가 구성되었습니다.',createdAt:new Date().toISOString()};store.notices.set(n.id,n)} return [...store.notices.values()]}
async function signup(req,env){const b=await body(req); for(const f of ['email','name','address','password']) if(!b[f]) return json({error:`${f} is required`},400); const email=sanitizeEmail(b.email); if(store.users.has(email)) return json({error:'email already exists'},409); const user={id:uid('user'),email,name:String(b.name),address:String(b.address),passwordHash:await sha256(String(b.password)),roles:email===sanitizeEmail(env.ADMIN_BOOTSTRAP_EMAIL)?['admin']:['user'],providers:['email'],createdAt:new Date().toISOString()}; store.users.set(email,user); audit(user.id,'user.signup'); return json({user:publicUser(user)},201)}
async function login(req,env){const b=await body(req); const email=sanitizeEmail(b.email); const user=store.users.get(email); if(!user || user.passwordHash!==await sha256(String(b.password||''))) return json({error:'invalid credentials'},401); const sid=uid('sess'); const ttl=Number(env.SESSION_TTL_SECONDS||86400); store.sessions.set(sid,{email,expiresAt:Date.now()+ttl*1000}); audit(user.id,'auth.login'); return json({user:publicUser(user)},200,{'set-cookie':`cp_session=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttl}${cookieDomain(env)}`})}
async function lostPassword(req){const b=await body(req); const email=sanitizeEmail(b.email); const user=store.users.get(email); if(user){const temp=crypto.randomUUID().replaceAll('-','').slice(0,16); user.passwordHash=await sha256(temp); audit(user.id,'auth.password_reset_requested',{provider:'firebase-email'}); return json({ok:true, delivery:'firebase-email', developmentTempPassword:temp})} return json({ok:true})}
async function createOrder(req,user){const b=await body(req); const amount=priceOf(b); if(amount===null) return json({error:'unknown product'},400); const free=isAdmin(user); const order={id:uid('bill'),userId:user.id,product:b.product,plan:b.plan||null,gb:b.gb||null,amountUsd:free?0:amount,adminFree:free,status:free?'approved':'pending',cartPath:`/${b.product}/cart/`,createdAt:new Date().toISOString()}; order.cartPath+=order.id; store.orders.set(order.id,order); audit(user.id,'order.create',{orderId:order.id,product:b.product}); return json({order,cartPath:order.cartPath},201)}
async function createInstance(req,user){const b=await body(req); const type=b.type||'wordpress'; const instance={id:uid('inst'),userId:user.id,type,name:b.name||`${type}-site`,status:'provisioning',network:{cdn:'cloudflare',dns:'automatic'},runtime:type==='wordpress'||type==='php'?'php-wasm':'static',database:type==='wordpress'?'CloudPressDB wordpress-nosql':null,storage:type==='wordpress'?'CP3 separate product':null,createdAt:new Date().toISOString()}; store.instances.set(instance.id,instance); audit(user.id,'instance.create',{instanceId:instance.id}); return json({instance},201)}
function orderDetail(url,user){const id=url.pathname.split('/').pop(); const order=store.orders.get(id); if(!order||(order.userId!==user.id&&!isAdmin(user))) return json({error:'order not found'},404); return json({order})}
function instanceDetail(url,user){const id=url.pathname.split('/').pop(); const instance=store.instances.get(id); if(!instance||instance.userId!==user.id) return json({error:'instance not found'},404); return json({instance})}
async function createNotice(req,user){if(!isAdmin(user)) return json({error:'admin required'},403); const b=await body(req); const notice={id:uid('notice'),title:String(b.title||'공지'),body:String(b.body||''),createdAt:new Date().toISOString(),author:user.email}; store.notices.set(notice.id,notice); return json({notice},201)}
function billingFor(user){const orders=[...store.orders.values()].filter(o=>o.userId===user.id); return {currency:'USD',adminFree:isAdmin(user),totalUsd:orders.reduce((s,o)=>s+o.amountUsd,0),orders}}
async function updateAccount(req,user){const b=await body(req); if(b.name) user.name=String(b.name); if(b.address) user.address=String(b.address); audit(user.id,'account.update'); return json({user:publicUser(user)})}
async function kvWrite(req,user){const b=await body(req); if(!b.key) return json({error:'key is required'},400); const kv=new CloudPressKV(user.id); await kv.put(b.key,b.value); return json({ok:true,key:b.key})}
async function sqlExec(req,user){const b=await body(req); const sql=new CloudPressSQL(user.id); return json(sql.execute(String(b.sql||''),Array.isArray(b.params)?b.params:[]))}
async function cp3Put(req,user){const b=await body(req); if(!b.name) return json({error:'name is required'},400); const meta=await new CP3(user.id).put(b.name,b.data||''); const {payload,...safe}=meta; return json({object:safe},201)}
async function admin(url,req,user){if(!isAdmin(user)) return json({error:'admin required'},403); if(url.pathname==='/api/admin/db') return json({service:await serviceSnapshot(), userKv:[...store.kv.entries()].map(([key,row])=>({key,...row})), tables:[...store.tables.entries()].map(([database,tables])=>({database,tables:[...tables.keys()]}))}); if(url.pathname==='/api/admin/storage') return json({serviceStorage:(await serviceSnapshot()).storageObjects, allObjects:[...store.objects.entries()].map(([key,obj])=>({key,name:obj.name,size:obj.size,sha256:obj.sha256,createdAt:obj.createdAt}))}); if(url.pathname==='/api/admin/users') return json({users:[...store.users.values()].map(publicUser)}); if(url.pathname==='/api/admin/orders') return json({orders:[...store.orders.values()]}); if(url.pathname==='/api/admin/settings' && req.method==='PATCH') {const b=await body(req); const platform=await ensureServicePlatform(); await platform.kv.put('site:config',{...(await platform.kv.get('site:config')), ...b, updatedAt:new Date().toISOString()}); return json({config:await platform.kv.get('site:config')});} return json({users:[...store.users.values()].map(publicUser),orders:[...store.orders.values()],instances:[...store.instances.values()],audit:store.audit,notices:[...store.notices.values()],service:await serviceSnapshot()})}
function shell(page){return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>클라우드프레스</title><link rel="stylesheet" href="/_next/static/css/landing-sso001.css"><link rel="stylesheet" href="/_next/static/css/landing-sso002.css"><link rel="stylesheet" href="/_next/static/css/landing-sso003.css"><link rel="stylesheet" href="/_next/static/css/dashboard001.css"><link rel="stylesheet" href="/_next/static/css/dashboard002.css"><link rel="stylesheet" href="/_next/static/css/dashboard003.css"><link rel="stylesheet" href="/app.css"></head><body><div id="app" data-page="${page}"></div><script src="/app.js"></script></body></html>`}
