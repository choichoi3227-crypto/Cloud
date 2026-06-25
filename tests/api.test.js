import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { catalog } from '../src/worker.js';
const env={SESSION_TTL_SECONDS:'86400',ADMIN_BOOTSTRAP_EMAIL:'admin@cloudpress.test',PRIMARY_DOMAIN:'example.com'};
async function call(host,path,{method='GET',body,cookie,env:envOverride}={}){return worker.fetch(new Request(`https://${host}${path}`,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},body:body&&JSON.stringify(body)}),envOverride||env)}
async function login(email='user@example.com'){await call('sso.example.com','/api/auth/signup',{method:'POST',body:{email,name:'User',address:'Seoul',password:'pw'}}); const res=await call('sso.example.com','/api/auth/login',{method:'POST',body:{email,password:'pw'}}); return res.headers.get('set-cookie').split(';')[0]}
test('catalog matches required pricing and product split',()=>{assert.equal(catalog.wordpress.plans.lite,14);assert.equal(catalog.wordpress.plans.duplex,76);assert.equal(catalog.cloudpressdb.price,10);assert.equal(catalog.cp3.basePrice,10);assert.equal(catalog.cp3.extraPerGb,0.5);assert.ok(catalog.cloudpressdb.types['wordpress-nosql']);assert.ok(catalog.cloudpressdb.types['general-sql']);});
test('subdomain page isolation and console login gate work',async()=>{let res=await call('bridge.example.com','/dashboard');assert.equal(res.status,404);res=await call('sso.example.com','/dashboard');assert.equal(res.status,404);res=await call('bridge-console.example.com','/dashboard');assert.equal(res.status,302);assert.match(res.headers.get('location'),/sso\.example\.com\/login/);const cookie=await login('console@example.com');res=await call('bridge-console.example.com','/dashboard',{cookie});assert.equal(res.status,200);res=await call('bridge-console.example.com','/login');assert.equal(res.status,404);res=await call('sso.example.com','/login');assert.equal(res.status,200);res=await call('bridge.example.com','/products');assert.equal(res.status,200);res=await call('bridge-console.example.com','/admin/db');assert.equal(res.status,302);res=await call('bridge-console.example.com','/admin/db',{cookie});assert.equal(res.status,200);res=await call('bridge.example.com','/admin/db');assert.equal(res.status,404);});
test('auth API is isolated to sso subdomain',async()=>{let res=await call('bridge.example.com','/api/auth/signup',{method:'POST',body:{email:'blocked@example.com',name:'B',address:'A',password:'pw'}});assert.equal(res.status,404);res=await call('sso.example.com','/api/auth/signup',{method:'POST',body:{email:'allowed@example.com',name:'A',address:'A',password:'pw'}});assert.equal(res.status,201);});
test('signup, login, order cart path, and instance provisioning work',async()=>{const cookie=await login('flow@example.com'); let res=await call('bridge.example.com','/api/orders',{method:'POST',cookie,body:{product:'wordpress',plan:'lite'}}); assert.equal(res.status,201); let data=await res.json(); assert.match(data.cartPath,/^\/wordpress\/cart\/bill_/); res=await call('bridge-console.example.com','/api/instances',{method:'POST',cookie,body:{type:'wordpress',name:'wp'}}); data=await res.json(); assert.equal(data.instance.database,'CloudPressDB wordpress-nosql'); assert.equal(data.instance.storage,'CP3 separate product');});
test('CloudPressDB KV/SQL and CP3 object APIs work for authenticated users',async()=>{const cookie=await login('data@example.com'); let res=await call('bridge-console.example.com','/api/cloudpressdb/kv',{method:'POST',cookie,body:{key:'hello',value:'world'}}); assert.equal(res.status,200); res=await call('bridge-console.example.com','/api/cloudpressdb/sql',{method:'POST',cookie,body:{sql:'create table posts (id,title)'}}); assert.equal((await res.json()).ok,true); res=await call('bridge-console.example.com','/api/cloudpressdb/sql',{method:'POST',cookie,body:{sql:'insert into posts (id,title) values (?,?)',params:['1','Post']}}); assert.equal((await res.json()).rows[0].title,'Post'); res=await call('bridge-console.example.com','/api/cp3/objects',{method:'POST',cookie,body:{name:'file.txt',data:'payload'}}); assert.equal(res.status,201); assert.equal((await res.json()).object.size,7);});
test('static bridge route renders the app shell',async()=>{const res=await call('bridge.example.com','/products'); assert.equal(res.status,200); assert.match(await res.text(),/data-page="\/bridge\/products.html"/);});

test('CloudPress service itself uses CloudPressDB and CP3 namespaces',async()=>{const res=await call('bridge.example.com','/api/service-platform'); assert.equal(res.status,200); const data=await res.json(); assert.equal(data.service.config.database,'CloudPressDB'); assert.equal(data.service.config.storage,'CP3'); assert.equal(data.service.config.capacity,'unlimited'); assert.ok(data.service.storageObjects[0].sha256);});
test('admin can inspect service DB/storage and receives free approved orders',async()=>{const cookie=await login('admin@cloudpress.test'); let res=await call('bridge.example.com','/api/orders',{method:'POST',cookie,body:{product:'cp3',gb:5000}}); let data=await res.json(); assert.equal(data.order.amountUsd,0); assert.equal(data.order.adminFree,true); assert.equal(data.order.status,'approved'); res=await call('bridge-console.example.com','/api/admin/db',{cookie}); assert.equal(res.status,200); data=await res.json(); assert.equal(data.service.config.database,'CloudPressDB'); res=await call('bridge-console.example.com','/api/admin/storage',{cookie}); assert.equal(res.status,200); data=await res.json(); assert.ok(Array.isArray(data.serviceStorage));});

test('product detail, order detail, and admin notice APIs work',async()=>{let res=await call('bridge.example.com','/api/products/cloudpressdb'); assert.equal(res.status,200); assert.equal((await res.json()).product.price,10); const adminCookie=await login('admin@cloudpress.test'); res=await call('bridge.example.com','/api/notices',{method:'POST',cookie:adminCookie,body:{title:'점검',body:'정상'}}); assert.equal(res.status,201); const notice=(await res.json()).notice; assert.equal(notice.title,'점검'); res=await call('bridge.example.com','/api/orders',{method:'POST',cookie:adminCookie,body:{product:'cloudpressdb'}}); const order=(await res.json()).order; res=await call('bridge.example.com',`/api/orders/${order.id}`,{cookie:adminCookie}); assert.equal((await res.json()).order.id,order.id);});
test('static HTML files contain meaningful fallback content',async()=>{const files=['public/bridge/index.html','public/console/dashboard.html','public/admin/db.html','public/sso/login.html','public/bridge/products/cloudpressdb.html']; for (const file of files){const html=await import('node:fs/promises').then(fs=>fs.readFile(file,'utf8')); assert.match(html,/<section class="hero">/); assert.ok(html.split('\n').length>20);}});

test('ADMIN_EMAIL secret grants admin on every login, even for a pre-existing user signed up before the secret was set',async()=>{
  // 1) 이 사용자는 일반 유저로 가입한다 (가입 시점엔 ADMIN_EMAIL이 아직 다른 값이었다고 가정).
  const lateAdminEnv={...env, ADMIN_EMAIL:'late-admin@example.com'};
  let res=await call('sso.example.com','/api/auth/signup',{method:'POST',body:{email:'late-admin@example.com',name:'Late Admin',address:'Seoul',password:'pw'}});
  assert.equal(res.status,201);
  let data=await res.json();
  assert.deepEqual(data.user.roles,['user']); // 가입 시점엔 아직 ADMIN_EMAIL secret이 설정되지 않았다고 가정
  // 2) 운영자가 나중에 ADMIN_EMAIL secret을 설정한 뒤 로그인하면, 그 즉시 admin 역할이 부여되어야 한다.
  res=await call('sso.example.com','/api/auth/login',{method:'POST',body:{email:'late-admin@example.com',password:'pw'},env:lateAdminEnv});
  assert.equal(res.status,200);
  const cookie=res.headers.get('set-cookie').split(';')[0];
  res=await call('bridge.example.com','/api/me',{cookie,env:lateAdminEnv});
  data=await res.json();
  assert.ok(data.user.roles.includes('admin'));
  // 3) admin 전용 API와 무료 주문도 즉시 동작해야 한다.
  res=await call('bridge-console.example.com','/api/admin/users',{cookie,env:lateAdminEnv});
  assert.equal(res.status,200);
  res=await call('bridge.example.com','/api/orders',{method:'POST',cookie,env:lateAdminEnv,body:{product:'wordpress',plan:'duplex'}});
  data=await res.json();
  assert.equal(data.order.amountUsd,0);
  assert.equal(data.order.adminFree,true);
});

test('legacy ADMIN_BOOTSTRAP_EMAIL secret still works for backward compatibility',async()=>{
  const cookie=await login('admin@cloudpress.test'); // env.ADMIN_BOOTSTRAP_EMAIL과 일치
  const res=await call('bridge.example.com','/api/me',{cookie});
  const data=await res.json();
  assert.ok(data.user.roles.includes('admin'));
});

test('users whose email does not match the admin secret never get admin role',async()=>{
  const cookie=await login('plain-user@example.com');
  const res=await call('bridge.example.com','/api/me',{cookie});
  const data=await res.json();
  assert.ok(!data.user.roles.includes('admin'));
});

test('GET /api/health reports github sync status (disabled by default, no secrets in test env)',async()=>{
  const res=await call('bridge.example.com','/api/health');
  const data=await res.json();
  assert.equal(data.durableObjects,false);
  assert.match(data.storage,/memory/);
  assert.equal(data.githubSync.configured,false);
});

test('with GITHUB_* secrets configured, a write triggers a background commit to data/snapshot.json',async()=>{
  // 가짜 GitHub API: 어떤 파일에 어떤 내용이 PUT 되는지 기록만 한다(실제 네트워크 호출 없음).
  const originalFetch = globalThis.fetch;
  const commits = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (!opts || !opts.method) { // sha lookup GET
      return new Response('not found', { status: 404 });
    }
    if (opts.method === 'PUT' && u.includes('contents/data/snapshot.json')) {
      commits.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ content: { sha: 'sha-test' } }), { status: 201 });
    }
    return new Response('{}', { status: 200 });
  };
  try{
    const githubEnv = { ...env, GITHUB_OWNER:'choichoi3227-crypto', GITHUB_REPO:'Cloud', GITHUB_TOKEN:'fake-token' };
    const res = await call('sso.example.com','/api/auth/signup',{method:'POST',env:githubEnv,body:{email:'github-sync@example.com',name:'GH',address:'Seoul',password:'pw'}});
    assert.equal(res.status,201);
    // scheduleSync는 50ms 디바운스 후 백그라운드로 커밋한다. 테스트 환경에는 ctx.waitUntil이 없으므로
    // 잠시 대기해 비동기 커밋이 끝날 시간을 준다.
    await new Promise(r=>setTimeout(r,150));
    assert.ok(commits.length>=1, 'expected at least one commit to data/snapshot.json');
    const lastCommit = commits[commits.length-1];
    const decoded = JSON.parse(Buffer.from(lastCommit.content,'base64').toString('utf8'));
    const savedUser = decoded.users.find(([email])=>email==='github-sync@example.com');
    assert.ok(savedUser, 'expected the new user to be present in the github snapshot');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
