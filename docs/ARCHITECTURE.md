# CloudPress complete hosting architecture

CloudPress is implemented as a Cloudflare Worker application without Durable Objects. The repository now contains backend APIs, static pages for each required domain area, shared UI assets, a product catalog, and local implementations of the CloudPressDB and CP3 interfaces for development and integration testing.

## Domain map

- `bridge.{domain}`: `/index`, `/feature`, `/about`, `/products`, `/notice`.
- `bridge-console.{domain}`: `/dashboard`, `/instances`, `/instance-detail`, `/payments`, `/billing`, `/accounts`, `/admin`.
- `sso.{domain}`: `/login`, `/signup`, `/lost-password`.

## Backend priorities

1. Backend: `src/worker.js` exposes auth, catalog, orders, instances, CloudPressDB KV/SQL, CP3 objects, admin, and health endpoints.
2. Products: `src/platform.js` defines WordPress hosting, CloudPressDB, CP3, static site, and PHP site products with prices and limits.
3. Frontend: `public/app.js` renders landing, SSO, console, cart, FAQ, product sub-navigation, and operational panels.
4. Remaining infrastructure: `wrangler.toml` configures Workers static assets; `public/**.html` provides concrete route files.

## Data layer

- CloudPressDB NoSQL is represented by `CloudPressKV`, a namespace-aware Key-Value engine.
- CloudPressDB SQL is represented by `CloudPressSQL`, a small serverless SQL execution interface supporting table creation, inserts, and selects for platform integration tests.
- CP3 is represented by `CP3`, an object namespace with size and SHA-256 integrity metadata.
- No Durable Objects are used.

## Security and availability

- Secure headers include CSP, HSTS, frame denial, content-type sniffing protection, referrer policy, and permissions policy.
- Sessions use `HttpOnly`, `Secure`, `SameSite=Lax` cookies.
- Admin APIs require an authenticated user with the `admin` role.
- `/api/health` exposes a health endpoint suitable for uptime monitoring.
- The Worker remains stateless at the routing tier, supporting Cloudflare multi-region execution and a 99.99% availability target.

## Required production secrets

Configure with `wrangler secret put`:

- `ADMIN_BOOTSTRAP_EMAIL`
- `JWT_SECRET`
- `GOOGLE_CLIENT_ID`
- `KAKAO_REST_API_KEY`
- `NAVER_CLIENT_ID`
- `FIREBASE_API_KEY`
- `CLOUDFLARE_GLOBAL_API_KEY`
- `CLOUDFLARE_ADMIN_EMAIL`
