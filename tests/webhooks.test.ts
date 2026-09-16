import { beforeEach, describe, expect, it } from "vitest";
import { applyGatewayState, mapStatus, processWebhook, type RzpSubscription, type RzpWebhookEvent } from "@/lib/billing";
import { signWebhookBody } from "@/lib/razorpay";
import { createOrg, resetDb, tenantDb, testDb } from "./helpers";

const PRO = process.env.RAZORPAY_PLAN_PRO!;
const TEAM = process.env.RAZORPAY_PLAN_TEAM!;

let seq = 0;
function makeEvent(
  orgId: string,
  overrides: Partial<RzpSubscription> & { event?: string; created_at?: number } = {},
): { body: string; eventId: string; event: RzpWebhookEvent } {
  const { event = "subscription.activated", created_at = 1_800_000_000 + seq, ...sub } = overrides;
  seq += 1;
  const e: RzpWebhookEvent = {
    entity: "event",
    event,
    created_at,
    payload: {
      subscription: {
        entity: {
          id: "sub_test123",
          plan_id: PRO,
          status: "active",
          customer_id: "cust_1",
          current_start: created_at,
          current_end: created_at + 30 * 86400,
          notes: { organisationId: orgId, tier: "PRO" },
          ...sub,
        },
      },
    },
  };
  return { body: JSON.stringify(e), eventId: `evt_${seq}`, event: e };
}

function deliver(body: string, eventId: string | null, signature: string | null = signWebhookBody(body)) {
  return processWebhook({ rawBody: body, signature, eventId });
}

async function setup() {
  const org = await createOrg();
  await testDb().subscription.create({ data: { organisationId: org.id, tier: "FREE" } });
  return { org, orgDb: tenantDb(org.id) };
}

describe("webhook security", () => {
  beforeEach(resetDb);

  it("rejects a missing or wrong signature with 401 and records nothing", async () => {
    const { org } = await setup();
    const { body, eventId } = makeEvent(org.id);
    expect(await deliver(body, eventId, null)).toMatchObject({ ok: false, status: 401 });
    expect(await deliver(body, eventId, "deadbeef")).toMatchObject({ ok: false, status: 401 });
    expect(await deliver(body, eventId, signWebhookBody(body, "other-secret"))).toMatchObject({ ok: false, status: 401 });
    expect(await testDb().webhookEvent.count()).toBe(0);
  });

  it("rejects a tampered body (signature was over different bytes)", async () => {
    const { org } = await setup();
    const { body, eventId } = makeEvent(org.id);
    const sig = signWebhookBody(body);
    const tampered = body.replace(PRO, TEAM);
    expect(await deliver(tampered, eventId, sig)).toMatchObject({ ok: false, status: 401 });
  });

  it("requires the event id header", async () => {
    const { org } = await setup();
    const { body } = makeEvent(org.id);
    expect(await deliver(body, null)).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects invalid JSON / non-event payloads", async () => {
    expect(await deliver("{not json", "evt_x")).toMatchObject({ ok: false, status: 400 });
    expect(await deliver(JSON.stringify({ hello: 1 }), "evt_y")).toMatchObject({ ok: false, status: 400 });
  });
});

describe("webhook idempotency", () => {
  beforeEach(resetDb);

  it("delivering the same event three times provisions exactly once", async () => {
    const { org, orgDb } = await setup();
    const { body, eventId } = makeEvent(org.id);

    const r1 = await deliver(body, eventId);
    const r2 = await deliver(body, eventId);
    const r3 = await deliver(body, eventId);

    expect(r1).toMatchObject({ ok: true, duplicate: false, applied: true });
    expect(r2).toMatchObject({ ok: true, duplicate: true, applied: false });
    expect(r3).toMatchObject({ ok: true, duplicate: true, applied: false });

    expect(await testDb().webhookEvent.count()).toBe(1);
    const sub = await orgDb.subscription.findFirstOrThrow();
    expect(sub.tier).toBe("PRO");
    expect(sub.status).toBe("ACTIVE");
    // Exactly one plan.changed audit entry, not three.
    expect(await orgDb.auditLog.count({ where: { action: "plan.changed" } })).toBe(1);
  });

  it("concurrent duplicate deliveries still apply once", async () => {
    const { org, orgDb } = await setup();
    const { body, eventId } = makeEvent(org.id);
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(body, eventId)));
    const applied = results.filter((r) => r.ok && r.applied).length;
    const dupes = results.filter((r) => r.ok && r.duplicate).length;
    expect(applied).toBe(1);
    expect(dupes).toBe(4);
    expect(await orgDb.auditLog.count({ where: { action: "plan.changed" } })).toBe(1);
  });

  it("marks processed events and stores the payload", async () => {
    const { org } = await setup();
    const { body, eventId } = makeEvent(org.id);
    await deliver(body, eventId);
    const row = await testDb().webhookEvent.findUniqueOrThrow({ where: { eventId } });
    expect(row.processedAt).not.toBeNull();
    expect(row.type).toBe("subscription.activated");
  });

  it("an event with no organisationId is recorded once and not applied", async () => {
    const { org, orgDb } = await setup();
    const { body, eventId } = makeEvent(org.id, { notes: {} });
    expect(await deliver(body, eventId)).toMatchObject({ ok: true, applied: false });
    expect(await deliver(body, eventId)).toMatchObject({ ok: true, duplicate: true });
    expect((await orgDb.subscription.findFirstOrThrow()).tier).toBe("FREE");
  });
});

describe("webhook ordering & state", () => {
  beforeEach(resetDb);

  it("ignores an older event that arrives after a newer one", async () => {
    const { org, orgDb } = await setup();
    const newer = makeEvent(org.id, { event: "subscription.cancelled", status: "cancelled", created_at: 2_000_000_000 });
    const older = makeEvent(org.id, { event: "subscription.activated", status: "active", created_at: 1_900_000_000 });

    await deliver(newer.body, newer.eventId);
    const r = await deliver(older.body, older.eventId);

    expect(r).toMatchObject({ ok: true, applied: false, reason: "out_of_order" });
    const sub = await orgDb.subscription.findFirstOrThrow();
    expect(sub.status).toBe("CANCELED");
    expect(sub.tier).toBe("FREE");
    expect(await testDb().webhookEvent.count()).toBe(2); // both recorded
  });

  it("maps every Razorpay status", () => {
    expect(mapStatus("active")).toEqual({ status: "ACTIVE", grantsTier: true });
    expect(mapStatus("authenticated")).toEqual({ status: "TRIALING", grantsTier: true });
    expect(mapStatus("pending")).toEqual({ status: "PAST_DUE", grantsTier: true });
    expect(mapStatus("halted")).toEqual({ status: "UNPAID", grantsTier: false });
    expect(mapStatus("cancelled")).toEqual({ status: "CANCELED", grantsTier: false });
    expect(mapStatus("created")).toEqual({ status: "INCOMPLETE", grantsTier: false });
  });

  it("an unknown plan id never grants a paid tier", async () => {
    const { org, orgDb } = await setup();
    const { body, eventId } = makeEvent(org.id, { plan_id: "plan_someone_elses" });
    await deliver(body, eventId);
    expect((await orgDb.subscription.findFirstOrThrow()).tier).toBe("FREE");
  });

  it("payment failure keeps the tier (PAST_DUE) and writes an audit entry", async () => {
    const { org, orgDb } = await setup();
    const a = makeEvent(org.id);
    await deliver(a.body, a.eventId);
    const f = makeEvent(org.id, { event: "subscription.pending", status: "pending" });
    await deliver(f.body, f.eventId);

    const sub = await orgDb.subscription.findFirstOrThrow();
    expect(sub.status).toBe("PAST_DUE");
    expect(sub.tier).toBe("PRO");
    expect(await orgDb.auditLog.count({ where: { action: "payment.failed" } })).toBe(1);
  });

  it("halted subscription degrades to Free", async () => {
    const { org, orgDb } = await setup();
    const a = makeEvent(org.id);
    await deliver(a.body, a.eventId);
    const h = makeEvent(org.id, { event: "subscription.halted", status: "halted" });
    await deliver(h.body, h.eventId);
    const sub = await orgDb.subscription.findFirstOrThrow();
    expect(sub.status).toBe("UNPAID");
    expect(sub.tier).toBe("FREE");
    expect(await orgDb.auditLog.count({ where: { action: "plan.canceled" } })).toBe(1);
  });

  it("events for another org's subscription cannot touch this org", async () => {
    const a = await setup();
    const b = await setup();
    // Event carries B's org id in notes but A's subscription id... notes win, and A is untouched.
    const ev = makeEvent(b.org.id, { id: "sub_for_b" });
    await deliver(ev.body, ev.eventId);
    expect((await a.orgDb.subscription.findFirstOrThrow()).tier).toBe("FREE");
    expect((await b.orgDb.subscription.findFirstOrThrow()).tier).toBe("PRO");
  });
});

describe("mid-cycle downgrade", () => {
  beforeEach(resetDb);

  it("keeps the paid tier until the gateway reports the new plan, then flips and clears pendingTier", async () => {
    const { org, orgDb } = await setup();
    // On Team.
    const t = makeEvent(org.id, { plan_id: TEAM, status: "active" });
    await deliver(t.body, t.eventId);
    expect((await orgDb.subscription.findFirstOrThrow()).tier).toBe("TEAM");

    // Customer schedules a downgrade (what changePlan() records locally).
    await orgDb.subscription.update({ where: { organisationId: org.id }, data: { pendingTier: "PRO" } });

    // Razorpay confirms the schedule; plan_id is still TEAM until cycle end.
    const upd = makeEvent(org.id, { event: "subscription.updated", plan_id: TEAM, status: "active", has_scheduled_changes: true });
    await deliver(upd.body, upd.eventId);
    let sub = await orgDb.subscription.findFirstOrThrow();
    expect(sub.tier).toBe("TEAM");
    expect(sub.pendingTier).toBe("PRO");

    // Cycle end: charged on the new plan.
    const charged = makeEvent(org.id, { event: "subscription.charged", plan_id: PRO, status: "active" });
    await deliver(charged.body, charged.eventId);
    sub = await orgDb.subscription.findFirstOrThrow();
    expect(sub.tier).toBe("PRO");
    expect(sub.pendingTier).toBeNull();
    expect(sub.gatewayPlanId).toBe(PRO);

    const log = await orgDb.auditLog.findMany({ where: { action: "plan.changed" }, orderBy: { createdAt: "asc" } });
    expect(log.map((l) => (l.metadata as { from: string; to: string }))).toEqual([
      { from: "FREE", to: "TEAM", gatewayStatus: "active", source: "webhook" },
      { from: "TEAM", to: "PRO", gatewayStatus: "active", source: "webhook" },
    ]);
  });

  it("cancel at cycle end: stays paid until cancelled event, then Free", async () => {
    const { org, orgDb } = await setup();
    const a = makeEvent(org.id);
    await deliver(a.body, a.eventId);
    await orgDb.subscription.update({ where: { organisationId: org.id }, data: { cancelAtPeriodEnd: true, pendingTier: "FREE" } });

    expect((await orgDb.subscription.findFirstOrThrow()).tier).toBe("PRO");

    const c = makeEvent(org.id, { event: "subscription.cancelled", status: "cancelled" });
    await deliver(c.body, c.eventId);
    const sub = await orgDb.subscription.findFirstOrThrow();
    expect(sub).toMatchObject({ tier: "FREE", status: "CANCELED", pendingTier: null, cancelAtPeriodEnd: false });
  });
});

describe("applyGatewayState via sync", () => {
  beforeEach(resetDb);

  it("the manual sync path applies the same state machine", async () => {
    const { orgDb } = await setup();
    const snapshot: RzpSubscription = { id: "sub_s", plan_id: PRO, status: "active", notes: {} };
    const r = await orgDb.$transaction((tx) => applyGatewayState(tx, snapshot, new Date(), { source: "sync", actorId: null }));
    expect(r).toMatchObject({ applied: true, tier: "PRO", status: "ACTIVE" });
  });
});
