# Orbit — Multi-Tenant SaaS with Subscriptions

A production-shaped B2B SaaS starter: users sign up, create an organisation
(tenant), invite teammates with roles, and subscribe to a plan. Feature access
is gated by tier and usage is metered.

**Stack:** Next.js (App Router) · TypeScript · PostgreSQL + Prisma · NextAuth ·
Stripe · Resend · Vercel

## Status

- [x] Phase 1 — Tenancy model, Prisma schema, tenant-isolation guard + tests
- [ ] Phase 2 — Auth + organisation creation
- [ ] Phase 3 — Invites + RBAC
- [ ] Phase 4 — Plans + feature flags
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
