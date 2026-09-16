import "dotenv/config";
import { createHmac } from "node:crypto";

/**
 * Webhook replay / duplicate-delivery test.
 *
 * Generates N distinct, validly-signed Razorpay-shaped events for one org and
 * delivers EACH one R times (simulating gateway retries), concurrently in
 * batches. Then reports how many were applied vs. deduplicated, and checks the
 * database for double-provisioning.
 *
 *   npm run replay -- --org <organisationId> [--events 50] [--retries 3] [--url http://localhost:3000]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((x) => x.length),
) as Record<string, string>;

const ORG = args.org;
const EVENTS = Number(args.events ?? 50);
const RETRIES = Number(args.retries ?? 3);
const URL = `${args.url ?? "http://localhost:3000"}/api/webhooks/razorpay`;
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const PRO = process.env.RAZORPAY_PLAN_PRO;

if (!ORG || !SECRET || !PRO) {
  console.error("Need --org <id>, RAZORPAY_WEBHOOK_SECRET and RAZORPAY_PLAN_PRO");
  process.exit(1);
}

const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

const runId = Date.now().toString(36);
const base = 1_800_000_000;

type Delivery = { eventId: string; body: string };
const deliveries: Delivery[] = [];
for (let i = 0; i < EVENTS; i++) {
  const body = JSON.stringify({
    entity: "event",
    event: i === 0 ? "subscription.activated" : "subscription.charged",
    created_at: base + i,
    payload: {
      subscription: {
        entity: {
          id: `sub_replay_${runId}`,
          plan_id: PRO,
          status: "active",
          customer_id: "cust_replay",
          current_start: base + i,
          current_end: base + i + 30 * 86400,
          notes: { organisationId: ORG, tier: "PRO" },
        },
      },
    },
  });
  deliveries.push({ eventId: `evt_${runId}_${i}`, body });
}

// Each event is delivered RETRIES times; shuffle so retries interleave like real life.
const queue = deliveries.flatMap((d) => Array.from({ length: RETRIES }, () => d));
for (let i = queue.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [queue[i], queue[j]] = [queue[j], queue[i]];
}

let applied = 0, duplicate = 0, ignored = 0, failed = 0;
const t0 = Date.now();
const CONCURRENCY = 10;
for (let i = 0; i < queue.length; i += CONCURRENCY) {
  await Promise.all(
    queue.slice(i, i + CONCURRENCY).map(async (d) => {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-razorpay-signature": sign(d.body), "x-razorpay-event-id": d.eventId },
        body: d.body,
      });
      if (!res.ok) return failed++;
      const j = (await res.json()) as { duplicate: boolean; applied: boolean };
      if (j.duplicate) duplicate++;
      else if (j.applied) applied++;
      else ignored++;
    }),
  );
}
const ms = Date.now() - t0;

console.log(`\nReplay ${runId}: ${EVENTS} events × ${RETRIES} deliveries = ${queue.length} requests in ${ms} ms`);
console.log(`  applied      : ${applied}`);
console.log(`  out-of-order : ${ignored}   (deliveries are shuffled; late older events are rejected)`);
console.log(`  applied+ooo  : ${applied + ignored}   (expected ${EVENTS} — one outcome per distinct event)`);
console.log(`  duplicate    : ${duplicate}   (expected ${EVENTS * (RETRIES - 1)} — retries deduplicated)`);
console.log(`  failed (5xx) : ${failed}`);

// Verify in the database: one WebhookEvent per event id, one plan change.
const { createClient } = await import("../src/lib/db");
const { db, disconnect } = createClient();
const rows = await db.webhookEvent.count({ where: { eventId: { startsWith: `evt_${runId}_` } } });
const sub = await db.subscription.findUnique({ where: { organisationId: ORG } });
const planChanges = await db.auditLog.count({
  where: { organisationId: ORG, action: "plan.changed", createdAt: { gte: new Date(t0) } },
});
console.log(`\nDatabase:`);
console.log(`  WebhookEvent rows for this run : ${rows}   (expected ${EVENTS})`);
console.log(`  Subscription tier/status       : ${sub?.tier}/${sub?.status}`);
console.log(`  plan.changed audit entries     : ${planChanges}   (expected exactly 1 — FREE→PRO once)`);
const ok = rows === EVENTS && applied + ignored === EVENTS && duplicate === EVENTS * (RETRIES - 1) && failed === 0 && planChanges === 1;
console.log(ok ? "\n✅ zero double-provisioning" : "\n❌ mismatch — investigate");
await disconnect();
process.exit(ok ? 0 : 1);
