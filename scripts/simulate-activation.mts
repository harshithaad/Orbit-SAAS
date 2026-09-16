import "dotenv/config";
import { createHmac } from "node:crypto";
import { createClient } from "../src/lib/db";

/**
 * Sends a signed `subscription.activated` webhook for an org's current
 * (INCOMPLETE) gateway subscription. Used when the Razorpay test sandbox
 * cannot complete a card mandate. Same payload shape, signature and code path
 * as a real delivery.
 *
 *   npx tsx scripts/simulate-activation.mts --slug acme-inc [--url http://localhost:3000]
 */
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((x) => x.length)) as Record<string, string>;
const url = `${args.url ?? "http://localhost:3000"}/api/webhooks/razorpay`;
const secret = process.env.RAZORPAY_WEBHOOK_SECRET!;

const { db, disconnect } = createClient();
const org = await db.organisation.findUniqueOrThrow({ where: { slug: args.slug }, include: { subscription: true } });
const sub = org.subscription!;
if (!sub.gatewaySubscriptionId) throw new Error("No gateway subscription on this org — click Upgrade first");

const now = Math.floor(Date.now() / 1000);
const body = JSON.stringify({
  entity: "event",
  event: "subscription.activated",
  created_at: now,
  payload: {
    subscription: {
      entity: {
        id: sub.gatewaySubscriptionId,
        plan_id: sub.gatewayPlanId,
        status: "active",
        customer_id: "cust_simulated",
        current_start: now,
        current_end: now + 30 * 86400,
        notes: { organisationId: org.id, tier: "PRO", slug: org.slug },
      },
    },
    payment: { entity: { id: `pay_sim_${now}`, amount: 74900, currency: "INR" } },
  },
});
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-razorpay-signature": createHmac("sha256", secret).update(body).digest("hex"), "x-razorpay-event-id": `evt_sim_${now}` },
  body,
});
console.log(res.status, await res.json());
const after = await db.subscription.findUniqueOrThrow({ where: { organisationId: org.id } });
console.log(`${org.slug}: ${after.tier}/${after.status} sub=${after.gatewaySubscriptionId} periodEnd=${after.currentPeriodEnd?.toDateString()}`);
await disconnect();
