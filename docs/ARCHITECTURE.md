# CloudPress complete hosting architecture

CloudPress is implemented as a Cloudflare Worker application without Durable Objects. The repository now contains backend APIs, static pages for each required domain area, shared UI assets, a product catalog, and local implementations of the CloudPressDB and CP3 interfaces for development and integration testing.

## Domain map

- `bridge.{domain}`: `/index`, `/feature`, `/about`, `/products`, `/notice`.
- `bridge-console.{domain}`: `/dashboard`, `/instances`, `/instance-detail`, `/payments`, `/billing`, `/accounts`, `/admin`.
- `sso.{domain}`: `/login`, `/signup`, `/lost-password`.

## Domain isolation

The Worker detects the request host and assigns one scope: `bridge`, `console`, `sso`, `dev`, or `unknown`. Page routes are only rendered in their correct scope. For example, `/dashboard` returns 404 on `bridge.{domain}` and `sso.{domain}` and only renders on `bridge-console.{domain}`. SSO pages only render on `sso.{domain}`. Landing and cart/product pages only render on `bridge.{domain}`.

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
- `/api/routes` documents allowed page routes per subdomain and is used by tests to keep domain boundaries explicit.
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

## CloudPress self-hosted service data

The CloudPress service site itself is bootstrapped into CloudPress-owned namespaces on every Worker request:

- `cloudpress-service-db`: CloudPressDB NoSQL namespace for site configuration and domain/runtime metadata.
- `cloudpress-service-sql`: CloudPressDB SQL namespace for service events.
- `cloudpress-service-cp3`: CP3 namespace for service-site assets and operational metadata.

The service configuration marks capacity as `unlimited`, so the CloudPress service site is not constrained by customer CP3 quotas. Admin users can inspect and update these namespaces from admin APIs and admin console pages.

## Admin free service policy

Users with the `admin` role can order and provision every product without payment. Their orders are recorded with `amountUsd: 0`, `adminFree: true`, and `status: approved`, keeping the audit/billing trail visible while avoiding charges.

## Admin pages and APIs

Additional admin pages are available under `bridge-console.{domain}`:

- `/admin/db`: inspect CloudPressDB service namespace, user KV rows, and SQL table names.
- `/admin/storage`: inspect service CP3 objects and all object metadata.
- `/admin/users`: inspect users.
- `/admin/orders`: inspect orders.
- `/admin/settings`: update service-site configuration.

Additional admin APIs:

- `GET /api/admin/db`
- `GET /api/admin/storage`
- `GET /api/admin/users`
- `GET /api/admin/orders`
- `PATCH /api/admin/settings`

## Static page completeness

Every required HTML route now contains semantic fallback content in addition to the JavaScript app shell. This keeps the pages meaningful before JavaScript hydration and makes each route inspectable as a standalone file. Product detail pages are also available under `public/bridge/products/` for WordPress hosting, CloudPressDB, CP3, static sites, and PHP sites.

## Additional product and operations APIs

- `GET /api/products/{slug}` returns a single product definition.
- `GET /api/orders/{billId}` returns a single authorized order.
- `POST /api/notices` lets admins create notices.
