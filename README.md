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
- [x] Phase 8 — 83 integration tests, replay harness, Vercel deploy config

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

Generates N distinct signed events, delivers each 3× in shuffled order with
concurrency 10, then checks the DB.

Last run (500 × 3): **1,500 deliveries → 1,000 duplicates rejected, 500 event
rows, exactly 1 plan change, 0 double-provisioning.** The shuffled order also
exercises the out-of-order rule: 491 late-arriving older events were recorded
but not applied.

An earlier run at 150 × 3 caught a real race — two *different* events for the
same org processed concurrently both read `tier = FREE` and both wrote a
`plan.changed` entry. Fixed with `SELECT … FOR UPDATE` on the org's
subscription row inside the transaction.

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

## The three questions

**1. A payment webhook is delivered three times. What happens?**
Each delivery hits `POST /api/webhooks/razorpay`, which reads the raw body and
verifies `X-Razorpay-Signature` (HMAC-SHA256, timing-safe). All three pass.
`processWebhook` then opens one transaction on the org-scoped client and
inserts `WebhookEvent(eventId = x-razorpay-event-id)` — a unique column. The
first delivery inserts, applies the state (`applyGatewayState`, under a row
lock on `Subscription`), writes one `AuditLog` row, marks the event processed,
commits, and *then* sends the receipt email. Deliveries two and three fail the
unique insert with P2002 before any state code runs, roll back, and are
answered `200 {duplicate: true}` so Razorpay stops retrying. One row changes,
one audit entry, one email (which also carries `receipt/<paymentId>` as a
provider idempotency key). The customer is charged once because Razorpay
charges once — our job is to *provision* once, and that's what the unique key
guarantees. Proven by `tests/webhooks.test.ts` and the replay harness above.

**2. How can Org A never read Org B's rows? Show the code path.**
`requireOrg(slug)` (`src/lib/org.ts`) → session user → `Membership` lookup
for (user, org) → `tenantDb(org.id)`. That membership lookup is the only place
an `organisationId` is ever derived; request input never supplies one.
`tenantDb` is a Prisma extension (`src/lib/tenant.ts`, `tenantScope`) that
rewrites every query on the six tenant models to include
`organisationId = <bound org>`, overriding anything the caller passed, and
then re-checks itself with `assertScoped`. The root client has a second
extension (`tenantGuard`) that throws `TenantScopeError` on any tenant-model
query without an org scope, so even code that bypasses `tenantDb` cannot run
an unscoped query. A test introspects `information_schema` to assert the guard
list equals the set of tables that actually have an `organisationId` column.

**3. A customer downgrades mid-cycle. Which records change?**
Immediately (`changePlan`, `schedule_change_at: "cycle_end"`):
`Subscription.pendingTier = PRO`, `cancelAtPeriodEnd = false`; one `AuditLog`
(`plan.change_scheduled`). The tier, limits and features are untouched — they
paid for the cycle. Razorpay sends `subscription.updated`
(`has_scheduled_changes: true`, old `plan_id`): a `WebhookEvent` row is
written, `gatewayEventAt` advances, nothing else changes. At cycle end Razorpay
sends `subscription.charged` with the new `plan_id`: another `WebhookEvent`;
`Subscription.tier = PRO`, `gatewayPlanId`, `currentPeriodStart/End`,
`pendingTier = null`, `gatewayEventAt`; one `AuditLog` (`plan.changed`,
TEAM→PRO); one receipt email to owners. Usage limits change implicitly
because they're read from `config/plans.ts` by tier; `UsageRecord` rows are
not rewritten — the next `consume()` simply compares against the lower cap.

## Deploy (Vercel + Neon)

1. Create a free Postgres on neon.tech; copy the pooled connection string.
2. Import the GitHub repo in Vercel. Build uses `npm run vercel-build`
   (`prisma generate && prisma migrate deploy && next build`).
3. Set env vars in Vercel: `DATABASE_URL`, `AUTH_SECRET`, `INVITE_SECRET`,
   `NEXT_PUBLIC_APP_URL` (your vercel.app URL), `AUTH_GITHUB_ID/SECRET`
   (callback `https://<app>.vercel.app/api/auth/callback/github`),
   `RESEND_API_KEY`, `EMAIL_FROM`, `RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET`,
   `RAZORPAY_PLAN_PRO/TEAM`. Do **not** set `DEV_LOGIN`.
4. In Razorpay (test mode) → Webhooks: URL
   `https://<app>.vercel.app/api/webhooks/razorpay`, secret =
   `RAZORPAY_WEBHOOK_SECRET`, events: all `subscription.*` + `payment.failed`.

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
