# Orbit — Multi-Tenant SaaS with Subscriptions

A production-shaped B2B SaaS starter: users sign up, create an organisation
(tenant), invite teammates with roles, and subscribe to a plan. Feature access
is gated by tier and usage is metered.

**Stack:** Next.js (App Router) · TypeScript · PostgreSQL + Prisma · NextAuth ·
Razorpay · Resend · Vercel

## Status

- [x] Phase 1 — Tenancy model, Prisma schema, tenant-isolation guard + tests
- [x] Phase 2 — Auth (GitHub / magic link / dev login) + organisation creation
- [x] Phase 3 — Signed invite links + RBAC (single `can()` check)
- [x] Phase 4 — Plans (Free/Pro/Team), 7 feature flags, 3 metered limits, gated UI + 403s
- [x] Phase 5 — Razorpay subscriptions, signature-verified idempotent webhooks, replay harness
- [x] Phase 6 — Usage metering (soft/hard limits, monthly + lifetime metrics, usage dashboard, 429s)
- [x] Phase 7 — Audit log + transactional email (invite, receipt, payment failed)
- [ ] Phase 8 — Integration tests, deploy

## Local setup

```bash
cp .env.example .env        # fill in secrets as phases require them
npm install
npm run db:up               # Postgres 16 in Docker (port 5433)
npm run db:migrate
npm run test:setup          # creates orbit_test DB + migrates it
npm test
npm run dev
```

## Auth & org resolution

`src/auth.ts` — Auth.js v5 with GitHub OAuth, Resend magic links (when
`RESEND_API_KEY` is set) and a **dev login** provider that is only registered
when `NODE_ENV !== "production"` and `DEV_LOGIN=true`.

`src/lib/org.ts` — `requireOrg(slug)` is the single entry point for anything
touching tenant data: it verifies the session, looks up the org, requires a
`Membership` row for (user, org), and returns `tenantDb(org.id)`. That
membership lookup is the only place an `organisationId` is ever derived from.

## RBAC

`src/lib/permissions.ts` is the only place roles are compared. One table maps
each action to a minimum role (OWNER ⊃ ADMIN ⊃ MEMBER); `can(role, action)` /
`assertCan(ctx, action)` are called by every server action and UI gate.
Role-change and removal rules (no self-change, last owner protected, admins
can't touch owners) live in `canChangeRole` / `canRemoveMember` and are
re-evaluated inside a transaction so they can't be raced.

## Invitations

`src/lib/invites.ts` — links are `/invite/<payload>.<hmac>` where the payload
(invitation id, org id, email, expiry) is HMAC-SHA256 signed with
`INVITE_SECRET`. Verification is timing-safe; the DB stores only a hash of the
token; acceptance flips PENDING→ACCEPTED atomically and requires the
signed-in email to match. Links expire after 7 days and one live link exists
per (org, email).

## Plans & feature flags

`src/config/plans.ts` is the only definition of what each tier unlocks: a
price, three metered limits (`members`, `projects`, `api_calls` — each with a
soft warn level and a hard cap) and seven boolean features. `src/lib/plans.ts`
answers every feature/limit question from that config plus the org's
`Subscription` row; a CANCELED/UNPAID subscription degrades to Free
(`effectiveTier`). `<FeatureGate>` renders upgrade prompts in the UI; the real
gate is `requireFeature()` in server code. Pages use `requireCan()` which
renders a 403 via Next's `forbidden()`.

## Billing (Razorpay, test mode)

`src/lib/billing.ts` is the state machine; `src/lib/razorpay.ts` the SDK and
signature checks.

- **Checkout never provisions.** `startCheckout` creates a Razorpay
  subscription with `notes.organisationId` and marks the row `INCOMPLETE`. The
  tier changes only when gateway state is applied through `applyGatewayState`
  (webhook, or `syncFromGateway` as a fallback/"refresh").
- **Webhook signature** — `X-Razorpay-Signature` is HMAC-SHA256 over the raw
  body, compared with `timingSafeEqual`. Bad signature → 401, nothing recorded.
- **Idempotency** — `x-razorpay-event-id` is inserted into `WebhookEvent`
  (unique) in the *same transaction* as the state change. A retry violates the
  constraint before any work runs and is acknowledged with 200. If processing
  throws, the insert rolls back too, so the gateway's retry gets a clean run.
- **Ordering** — every applied event stamps `gatewayEventAt`; older events are
  recorded but not applied.
- **Concurrency** — `applyGatewayState` takes `SELECT … FOR UPDATE` on the
  org's subscription so concurrent *distinct* events are serialised.
- **Downgrades** are scheduled at cycle end (`pendingTier`); upgrades apply now.
  Cancel = downgrade to Free at cycle end. A CANCELED/UNPAID subscription
  degrades to Free access without touching data.

### Replay harness (the resume number)

```bash
npm run replay -- --org <organisationId> --events 150 --retries 3
```

Generates 150 distinct signed events, delivers each 3× in shuffled order with
concurrency 10, then checks the DB. Last run: **450 deliveries → 300 duplicates
rejected, 150 event rows, exactly 1 plan change, 0 double-provisioning.**

## Usage metering

`src/lib/usage.ts`. One `UsageRecord` per (org, metric, period). `consume()`
runs inside the transaction that performs the metered action: it locks the
counter row (`FOR UPDATE`), compares against the plan's hard limit, and either
increments or throws `UsageLimitError` — so the action rolls back with it and
concurrent requests can't both slip under the cap. Soft limits only produce
warnings. Monthly metrics (`api_calls`) reset on the 1st (UTC); row-backed
metrics (`members`, `projects`) reconcile from the live count so deletions
free quota. `POST /api/v1/ping` is a metered example endpoint that returns
`429` with `x-ratelimit-*` headers at the cap.

## Audit log & email

Every sensitive action writes an `AuditLog` row inside the same transaction
as the action (`src/lib/audit.ts`): org created, invite sent/revoked, member
joined/removed, role changed, checkout started, plan change scheduled/applied,
cancellation, payment failure, project deleted. Viewing it is a Pro feature.

`src/lib/email.ts` sends via Resend when `RESEND_API_KEY` is set and logs to
the console otherwise; tests swap in a capturing transport. Emails are sent
*after* the owning transaction commits, never inside it, and each carries a
provider idempotency key (`invite/<id>`, `receipt/<paymentId>`,
`payment-failed/<eventId>`). Templates: invitation, receipt (on
`subscription.charged`), payment failed / subscription halted (to owners).

## Tenant isolation (how Org A can never read Org B)

Every table holding tenant data has an `organisationId` column
(`src/lib/tenant.ts` → `TENANT_MODELS`). Two layers enforce the rule:

1. **Guard** — a Prisma client extension on the root client throws
   `TenantScopeError` for any query on a tenant model whose `where`/`data`
   does not pin an `organisationId`. An unscoped query cannot reach Postgres.
2. **Scoped client** — `tenantDb(organisationId)` injects the org id into
   every tenant-model query, overriding anything the caller passed. Application
   code uses this exclusively; the org id comes from the caller's verified
   membership, never from request input.

A test introspects `information_schema` to assert the guard's model list
matches every table that actually has an `organisationId` column, so a new
tenant table can't slip past it.
