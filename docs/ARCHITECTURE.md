# CloudPress Architecture v2

## 핵심 원칙

- **100% 자체 제작 엔진**: CloudPressDB, CP3, SessionStore, AuditLog — Cloudflare KV/D1/R2/Durable Objects 완전 미사용
- **100% 영속 (Persistent)**: Worker isolate가 죽어도 데이터는 GitHub에 남아 있어 재시작 즉시 복원
- **다운타임 제로**: CAS(Compare-And-Swap) + 재시도로 충돌 없는 동시 쓰기
- **100% 서버리스**: Cloudflare Workers 엣지에서만 실행, 외부 서버 없음
- **Non-blocking I/O**: 모든 I/O는 `await`/`Promise.all` 기반 병렬 처리

## 소스 파일 구조

```
src/
  engine.js    — CloudPressDB + CP3 + SessionStore + AuditLog 완전 자체 제작 영속 엔진
  platform.js  — 비즈니스 로직, 상품 카탈로그, 사용자/주문/인스턴스 헬퍼
  worker.js    — Cloudflare Worker 엔트리, HTTP 라우팅, API 핸들러
public/
  app.js       — 프론트엔드 SPA (라우터, SSO, 콘솔, 랜딩)
  ...
tests/
  engine.test.js — CloudPressDB/CP3 유닛 테스트
  api.test.js    — Worker API 통합 테스트 (GitHub mock 포함)
```

## 저장소 구조 (GitHub repo의 data/ 폴더)

```
data/
  db/
    {namespace}/
      kv.json                     — CloudPressKV 컬렉션
      {table_name}.json           — CloudPressSQL 테이블 로우
  sessions/
    {sid}.json                    — HMAC 서명 세션 (암호화됨)
  cp3/
    {bucket}/
      index.json                  — CP3 오브젝트 메타데이터 인덱스
      obj/{key}                   — CP3 오브젝트 데이터 (1MB 초과 시 자동 청크 분할)
  audit.json                      — 감사 로그 (최대 1000건 순환)
```

## CloudPressDB 엔진 (engine.js)

### CloudPressKV
- `put(key, value)`: GitHub에 KV 컬렉션 파일 업데이트 (CAS 자동 재시도)
- `get(key)`: GitHub에서 KV 컬렉션 읽기 (요청 내 캐시로 중복 fetch 제거)
- `delete(key)`: KV 항목 삭제 후 파일 업데이트
- `list(prefix)`: prefix 필터링된 항목 목록

### CloudPressSQL
- 지원 구문: `CREATE TABLE`, `DROP TABLE`, `INSERT INTO`, `SELECT * FROM`, `UPDATE SET WHERE`, `DELETE FROM WHERE`
- `WHERE col = ?` 조건절 (AND 연결 지원)
- `LIMIT n` 지원
- 각 테이블은 GitHub 파일 하나로 저장

### CP3 (오브젝트 스토리지)
- `put(name, data)`: 1MB 초과 시 자동 청크 분할, 청크 병렬 업로드
- `get(name)`: 청크 병렬 다운로드 후 조합
- `delete(name)`: 청크 파일 병렬 삭제 + 인덱스 업데이트
- `list(prefix)`: 인덱스 파일 기반 목록 조회

### SessionStore
- `create(email, ttl)`: HMAC-SHA256 서명 세션 생성, GitHub에 저장
- `get(sid)`: GitHub에서 세션 읽기 + 서명 검증 + 만료 체크
- `delete(sid)`: GitHub에서 세션 파일 삭제
- `cleanup()`: 만료된 세션 일괄 정리 (백그라운드)

### AuditLog
- `append(actor, action, meta)`: 감사 항목 추가 (백그라운드 flush)
- `getAll()`: 전체 감사 로그 조회

## API 엔드포인트

### 공개 API
- `GET /api/health` — 서비스 상태
- `GET /api/routes` — 도메인별 허용 경로
- `GET /api/products` — 전체 상품 목록
- `GET /api/products/{slug}` — 상품 상세
- `GET /api/notices` — 공지사항 목록
- `GET /api/service-platform` — 서비스 플랫폼 스냅샷

### 인증 API (sso.{domain} 전용)
- `POST /api/auth/signup` — 회원가입
- `POST /api/auth/login` — 로그인 (세션 쿠키 발급)
- `POST /api/auth/logout` — 로그아웃 (세션 삭제)
- `POST /api/auth/lost-password` — 비밀번호 재설정

### 인증 필요 API
- `GET  /api/me` — 현재 사용자 정보
- `GET  /api/orders` — 주문 목록
- `POST /api/orders` — 주문 생성
- `GET  /api/orders/{id}` — 주문 상세
- `GET  /api/billing` — 청구 현황
- `GET  /api/payments` — 결제 내역
- `PATCH /api/accounts` — 계정 정보 수정
- `GET  /api/instances` — 인스턴스 목록
- `POST /api/instances` — 인스턴스 생성
- `GET  /api/instances/{id}` — 인스턴스 상세
- `GET  /api/cloudpressdb/kv` — KV 목록
- `POST /api/cloudpressdb/kv` — KV 쓰기
- `DELETE /api/cloudpressdb/kv` — KV 삭제
- `POST /api/cloudpressdb/sql` — SQL 실행
- `GET  /api/cloudpressdb/tables` — 테이블 목록
- `GET  /api/cp3/objects` — 오브젝트 목록
- `POST /api/cp3/objects` — 오브젝트 업로드
- `GET  /api/cp3/objects/{name}` — 오브젝트 다운로드
- `DELETE /api/cp3/objects/{name}` — 오브젝트 삭제

### 관리자 전용 API (admin 역할 필요)
- `GET  /api/admin/db` — DB 현황
- `GET  /api/admin/storage` — 스토리지 현황
- `GET  /api/admin/users` — 사용자 목록
- `GET  /api/admin/orders` — 전체 주문
- `GET  /api/admin/audit` — 감사 로그
- `PATCH /api/admin/settings` — 서비스 설정 수정

## 보안

- HMAC-SHA256 세션 서명 (`JWT_SECRET`)
- HttpOnly + Secure + SameSite=Lax 세션 쿠키
- CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy 보안 헤더
- HTML shell XSS 방지 (`escHtml`)
- auth API는 sso 서브도메인에서만 허용
- admin API는 admin 역할 사용자만 허용
- Rate Limiting: IP당 분당 120 요청

## 필수 Worker Secrets

```bash
wrangler secret put GITHUB_OWNER   # 예: choichoi3227-crypto
wrangler secret put GITHUB_REPO    # 예: Cloud
wrangler secret put GITHUB_TOKEN   # GitHub PAT (Contents r/w)
wrangler secret put JWT_SECRET     # 무작위 긴 문자열
wrangler secret put ADMIN_EMAIL    # 관리자 이메일
```

## 도메인 구조

- `bridge.{domain}` — 랜딩, 상품, 공지, 장바구니
- `bridge-console.{domain}` — 대시보드, 인스턴스, 관리자 콘솔
- `sso.{domain}` — 로그인, 회원가입, 비밀번호 찾기
