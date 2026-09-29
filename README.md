# Orbit

Multi-tenant B2B SaaS platform with organisations, role-based access,
subscription billing and usage metering.

Users sign up, create an organisation, invite teammates, and subscribe to a
plan. Each plan unlocks a set of features and usage limits, and billing is
driven by Razorpay subscriptions.

**Built with** Next.js (App Router) · TypeScript · PostgreSQL · Prisma ·
Auth.js · Razorpay · Resend · Tailwind CSS

## Features

- **Organisations** — every user can create or join multiple organisations;
  all data is scoped to one of them and isolated at the data-access layer.
- **Authentication** — GitHub OAuth and email magic links.
- **Team management** — email invitations via signed, expiring links, and
  three roles (Owner, Admin, Member) with a single permission model.
- **Subscription billing** — Free, Pro and Team plans on Razorpay, with
  immediate upgrades, end-of-cycle downgrades and cancellation.
- **Feature gating** — plan-based features enforced on the server, with
  upgrade prompts in the UI.
- **Usage metering** — per-organisation limits on members, projects and API
  calls, with warning thresholds, hard caps and a usage dashboard.
- **Audit log** — a record of every sensitive action in the organisation.
- **Transactional email** — invitations, payment receipts and payment-failure
  notices.

## Plans

|                     | Free | Pro     | Team      |
| ------------------- | ---- | ------- | --------- |
| Price (per month)   | ₹0   | ₹749    | ₹2,499    |
| Members             | 3    | 10      | Unlimited |
| Projects            | 3    | 25      | Unlimited |
| API calls / month   | 100  | 2,000   | 20,000    |
| Audit log           | —    | ✓       | ✓         |
| Audit log export    | —    | —       | ✓         |
| API access          | —    | ✓       | ✓         |
| Advanced analytics  | —    | ✓       | ✓         |
| Custom roles        | —    | —       | ✓         |
| Single sign-on      | —    | —       | ✓         |
| Priority support    | —    | —       | ✓         |

Plans are defined in one place, [`src/config/plans.ts`](src/config/plans.ts).
Changing a price, limit or feature there updates gating, metering and the
billing page together.

## Getting started

### Prerequisites

- Node.js 20+
- Docker (for the local PostgreSQL database)

### Setup

```bash
cp .env.example .env
npm install
npm run db:up        # starts PostgreSQL 16 in Docker on port 5433
npm run db:migrate
npm run dev
```

Open http://localhost:3000. With `DEV_LOGIN=true` in `.env` you can sign in
locally without configuring an OAuth provider. The dev login is never enabled
in production builds.

### Environment variables

| Variable                    | Description                                            |
| --------------------------- | ------------------------------------------------------ |
| `DATABASE_URL`              | PostgreSQL connection string                           |
| `TEST_DATABASE_URL`         | Separate database used by the test suite               |
| `NEXT_PUBLIC_APP_URL`       | Public base URL of the app                             |
| `AUTH_SECRET`               | Session secret (`openssl rand -base64 32`)             |
| `INVITE_SECRET`             | HMAC key for invitation links                          |
| `DEV_LOGIN`                 | Enables passwordless sign-in in development only       |
| `AUTH_GITHUB_ID` / `_SECRET`| GitHub OAuth app credentials                           |
| `RESEND_API_KEY`            | Resend API key; enables magic links and outgoing email |
| `EMAIL_FROM`                | Sender address for outgoing email                      |
| `RAZORPAY_KEY_ID` / `_SECRET` | Razorpay API keys                                    |
| `RAZORPAY_WEBHOOK_SECRET`   | Secret used to verify Razorpay webhooks                |
| `RAZORPAY_PLAN_PRO` / `_TEAM` | Razorpay plan IDs for the paid tiers                 |

Without `RESEND_API_KEY`, emails are printed to the server console instead of
being sent.

### Scripts

| Command              | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `npm run dev`        | Start the development server                         |
| `npm run build`      | Production build                                     |
| `npm test`           | Run the integration test suite                       |
| `npm run test:setup` | Create and migrate the test database                 |
| `npm run typecheck`  | Type-check the project                               |
| `npm run lint`       | Lint the project                                     |
| `npm run db:up`      | Start the local database                             |
| `npm run db:migrate` | Apply Prisma migrations                              |
| `npm run db:studio`  | Open Prisma Studio                                   |
| `npm run replay`     | Run the webhook replay load test (see [Testing](#testing)) |

## Project structure

```
prisma/              Database schema and migrations
scripts/             Test DB setup, webhook replay and sandbox helpers
src/
  app/               Next.js routes
    app/[orgSlug]/   Organisation workspace: projects, members, billing, usage, audit
    api/             Auth, Razorpay webhooks, metered public API (/api/v1)
  components/        UI components
  config/plans.ts    Plan, feature and limit definitions
  lib/               Core domain logic (tenancy, permissions, billing, usage, email)
tests/               Integration tests
```

## Architecture

### Tenant isolation

Every table that holds organisation data has an `organisationId` column, and
two layers make sure one organisation can never read another's data
([`src/lib/tenant.ts`](src/lib/tenant.ts)):

1. **Scoped client.** `tenantDb(organisationId)` is a Prisma extension that
   adds the organisation ID to every query on tenant tables, overriding
   whatever the caller passed. Application code only accesses tenant data
   through it.
2. **Guard.** The root Prisma client rejects any query on a tenant table that
   isn't scoped to an organisation, so code that bypasses `tenantDb` fails
   instead of leaking data.

The organisation ID always comes from `requireOrg(slug)`
([`src/lib/org.ts`](src/lib/org.ts)), which checks the session and the user's
membership in that organisation. It is never taken from request input. A test
compares the guard's table list against the live database schema, so a new
tenant table can't be added without protection.

### Roles and permissions

[`src/lib/permissions.ts`](src/lib/permissions.ts) maps each action to a
minimum role (Owner > Admin > Member). Every server action and UI check goes
through `can(role, action)`. Membership rules — you can't change your own
role, the last owner can't be removed, admins can't modify owners — are
re-checked inside a transaction to prevent races.

### Invitations

Invitation links carry an HMAC-SHA256-signed payload (invitation, organisation,
email, expiry) and are verified in constant time
([`src/lib/invites.ts`](src/lib/invites.ts)). Only a hash of the token is
stored. Links expire after 7 days, only one active link exists per email per
organisation, and accepting requires signing in with the invited address.

### Plans and feature gating

[`src/lib/plans.ts`](src/lib/plans.ts) answers every "can this organisation do
X?" question from the plan config and the organisation's subscription. A
cancelled or unpaid subscription falls back to Free access without deleting
any data. The UI shows upgrade prompts, but enforcement happens server-side
through `requireFeature()` and `requireCan()`, which return a 403.

### Billing

[`src/lib/billing.ts`](src/lib/billing.ts) manages the subscription lifecycle;
[`src/lib/razorpay.ts`](src/lib/razorpay.ts) wraps the Razorpay SDK.

- **Provisioning happens on confirmation only.** Starting a checkout creates
  a Razorpay subscription and marks it incomplete. The plan changes only when
  Razorpay confirms it through a webhook (or a manual sync from the gateway).
- **Webhook verification.** `POST /api/webhooks/razorpay` checks the
  `X-Razorpay-Signature` HMAC over the raw body. Invalid requests get a 401
  and are not recorded.
- **Exactly-once processing.** Each event ID is inserted into a unique
  `WebhookEvent` table in the same transaction as the state change. Repeat
  deliveries hit the unique constraint before any work runs and are
  acknowledged with a 200. If processing fails, the whole transaction rolls
  back so Razorpay's retry starts clean.
- **Ordering.** Events older than the last applied event are recorded but not
  applied.
- **Concurrency.** Different events for the same organisation are serialised
  with a row lock (`SELECT … FOR UPDATE`) on its subscription.
- **Plan changes.** Upgrades apply immediately. Downgrades and cancellations
  are scheduled for the end of the billing cycle, so customers keep what they
  paid for until then.

### Usage metering

[`src/lib/usage.ts`](src/lib/usage.ts) keeps one counter per organisation,
metric and period. `consume()` runs inside the same transaction as the
metered action: it locks the counter, checks the plan's hard limit, and either
increments or throws — rolling the action back with it. Concurrent requests
can't both slip under the cap. API call counts reset monthly (UTC); member and
project counts are reconciled from live data, so deleting a project frees
quota.

`POST /api/v1/ping` is an example metered endpoint. At the limit it returns
`429` with `x-ratelimit-*` headers.

### Audit log and email

Sensitive actions (organisation created, invites, membership and role
changes, plan changes, cancellations, payment failures, deletions) write an
audit entry in the same transaction as the action
([`src/lib/audit.ts`](src/lib/audit.ts)). The audit log is available on Pro
and Team.

Emails ([`src/lib/email.ts`](src/lib/email.ts)) are sent through Resend only
after the related transaction commits, and each carries an idempotency key so
a retry never sends a duplicate.

## Testing

The integration tests run against a real PostgreSQL database and cover tenant
isolation, permissions, invitations, plan gating, usage limits, webhooks and
email.

```bash
npm run test:setup   # once: creates and migrates the orbit_test database
npm test
```

### Webhook replay

`npm run replay` load-tests webhook handling by generating signed events and
delivering each one several times, in shuffled order and concurrently, then
checking the database:

```bash
npm run replay -- --org <organisationId> --events 500 --retries 3
```

In a run of 500 events × 3 deliveries (1,500 requests), all 1,000 duplicates
were rejected, exactly one plan change was applied, and no subscription was
provisioned twice. Out-of-order events were recorded without being applied.

### Simulating activation in the Razorpay sandbox

Razorpay's test mode can't always complete a card mandate. To activate a
subscription locally, send a signed `subscription.activated` webhook through
the normal code path:

```bash
npx tsx scripts/simulate-activation.mts --slug <org-slug> [--url http://localhost:3000]
```

## Deployment

Orbit deploys to Vercel with a managed PostgreSQL database such as Neon.

1. Create a PostgreSQL database and copy its pooled connection string.
2. Import the repository into Vercel. The build runs `npm run vercel-build`,
   which applies migrations before building.
3. Set the [environment variables](#environment-variables) in Vercel, with
   `NEXT_PUBLIC_APP_URL` set to your deployment URL. Do **not** set
   `DEV_LOGIN`.
4. Set the GitHub OAuth callback URL to
   `https://<your-app>/api/auth/callback/github`.
5. In the Razorpay dashboard, add a webhook pointing to
   `https://<your-app>/api/webhooks/razorpay` with your
   `RAZORPAY_WEBHOOK_SECRET`, subscribed to all `subscription.*` events and
   `payment.failed`.
