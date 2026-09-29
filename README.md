# Orbit

Multi-tenant B2B SaaS platform: users create organisations, invite teammates
with roles, and subscribe to plans that gate features and meter usage.

**Stack:** Next.js · TypeScript · PostgreSQL · Prisma · Auth.js · Razorpay · Resend · Vercel

## Features

- Organisations with isolated data, GitHub / magic-link sign-in
- Signed, expiring email invites and Owner / Admin / Member roles
- Free, Pro and Team plans on Razorpay subscriptions
- Plan-based feature gating and usage limits (members, projects, API calls)
- Audit log and transactional email (invites, receipts, payment failures)

## How it works

**Tenant isolation.** Every tenant table has an `organisationId`. All access
goes through `tenantDb(orgId)`, a Prisma extension that forces the org scope
on every query. The org ID comes from the user's verified membership, never
from request input, and the root client rejects any unscoped query.

**Permissions.** One function, `can(role, action)`, decides every permission
check across server actions and UI.

**Billing.** Checkout never grants a plan; only a verified Razorpay webhook
does. Webhooks are:

- **Authenticated** — HMAC signature checked against the raw body.
- **Idempotent** — the event ID is saved with a unique constraint in the same
  transaction as the plan change, so duplicate deliveries are no-ops.
- **Ordered** — events older than the last applied one are ignored.
- **Race-safe** — a row lock on the subscription serialises concurrent events.

Upgrades apply immediately; downgrades take effect at the end of the billing
cycle.

**Usage limits.** The usage counter is locked and checked in the same
transaction as the action, so concurrent requests can't exceed the cap. Over
the limit, the API returns `429`.

**Email.** Sent only after the transaction commits, with an idempotency key
to prevent duplicates.

## Testing

Integration tests run against a real PostgreSQL database. A replay script
load-tests webhooks by sending each event multiple times, shuffled and
concurrent:

> 1,500 deliveries (500 events × 3) → 1,000 duplicates rejected, 1 plan
> change, 0 double-provisioning.

An early run caught a race where two concurrent events for the same org both
recorded a plan change; a row lock fixed it.

## Run locally

```bash
cp .env.example .env
npm install
npm run db:up && npm run db:migrate
npm run dev
```

Tests: `npm run test:setup && npm test`
