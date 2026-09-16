# Orbit — Multi-Tenant SaaS with Subscriptions

A production-shaped B2B SaaS starter: users sign up, create an organisation
(tenant), invite teammates with roles, and subscribe to a plan. Feature access
is gated by tier and usage is metered.

**Stack:** Next.js (App Router) · TypeScript · PostgreSQL + Prisma · NextAuth ·
Stripe · Resend · Vercel

## Status

- [x] Phase 1 — Tenancy model, Prisma schema, tenant-isolation guard + tests
- [x] Phase 2 — Auth (GitHub / magic link / dev login) + organisation creation
- [x] Phase 3 — Signed invite links + RBAC (single `can()` check)
- [x] Phase 4 — Plans (Free/Pro/Team), 7 feature flags, 3 metered limits, gated UI + 403s
- [ ] Phase 5 — Stripe billing + idempotent webhooks
- [ ] Phase 6 — Usage metering
- [ ] Phase 7 — Audit log + transactional email
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
