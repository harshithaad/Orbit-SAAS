import type { PlanTier, SubscriptionStatus } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { db, tenantDb, type TenantDb, type TenantTx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ForbiddenError } from "@/lib/errors";
import { isUpgrade } from "@/lib/plans";
import { planIdFor, razorpay, tierForPlanId, verifyWebhookSignature } from "@/lib/razorpay";
import { PLANS } from "@/config/plans";
import { notifyPaymentFailed, notifyReceipt } from "@/lib/notify";

/**
 * Billing state machine.
 *
 * Source of truth for an org's plan is the `Subscription` row, and the only
 * thing that moves it to a paid tier is a Razorpay *event* (webhook or an
 * explicit fetch via `syncFromGateway`) passed through `applyGatewayState`.
 * Checkout itself never provisions anything.
 *
 * Idempotency (webhooks):
 *   `processWebhook` inserts a `WebhookEvent` row keyed by Razorpay's
 *   `x-razorpay-event-id` and applies the state change in the SAME
 *   transaction. A duplicate delivery violates the unique constraint before
 *   anything else runs, so it is acknowledged (200) and ignored. If processing
 *   throws, the transaction rolls back including the insert, so Razorpay's
 *   retry gets a clean attempt.
 *
 * Ordering:
 *   Each applied event stamps `gatewayEventAt`. An event older than that is a
 *   late/out-of-order delivery and is recorded but not applied.
 *
 * Concurrency:
 *   `applyGatewayState` takes a row lock on the org's Subscription, so
 *   concurrent deliveries of *different* events for one org are serialised.
 */

// ---------------------------------------------------------------------------
// Razorpay entity shapes (only the fields we read)
// ---------------------------------------------------------------------------

export type RzpSubscriptionStatus =
  | "created"
  | "authenticated"
  | "active"
  | "pending"
  | "halted"
  | "cancelled"
  | "completed"
  | "expired"
  | "paused";

export type RzpSubscription = {
  id: string;
  plan_id: string;
  status: RzpSubscriptionStatus;
  customer_id?: string | null;
  current_start?: number | null;
  current_end?: number | null;
  has_scheduled_changes?: boolean;
  notes?: Record<string, string> | string[] | null;
};

export type RzpWebhookEvent = {
  entity: "event";
  event: string; // e.g. "subscription.activated"
  created_at: number; // unix seconds
  payload: {
    subscription?: { entity: RzpSubscription };
    payment?: { entity: { id: string; amount: number; currency: string; error_description?: string | null } };
  };
};

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/** Razorpay status -> ours. `grantsTier` = whether the plan's features apply. */
export function mapStatus(s: RzpSubscriptionStatus): { status: SubscriptionStatus; grantsTier: boolean } {
  switch (s) {
    case "created":
      return { status: "INCOMPLETE", grantsTier: false };
    case "authenticated": // mandate approved, first charge queued
      return { status: "TRIALING", grantsTier: true };
    case "active":
      return { status: "ACTIVE", grantsTier: true };
    case "pending": // a charge failed, Razorpay is retrying
      return { status: "PAST_DUE", grantsTier: true };
    case "halted": // retries exhausted
    case "paused":
      return { status: "UNPAID", grantsTier: false };
    case "cancelled":
    case "completed":
    case "expired":
      return { status: "CANCELED", grantsTier: false };
  }
}

function orgIdFromNotes(notes: RzpSubscription["notes"]): string | null {
  if (!notes || Array.isArray(notes)) return null;
  return notes.organisationId ?? null;
}

// ---------------------------------------------------------------------------
// Applying gateway state
// ---------------------------------------------------------------------------

export type ApplyResult = { applied: boolean; reason?: string; tier?: PlanTier; status?: SubscriptionStatus };

/**
 * Applies a Razorpay subscription snapshot to the org's Subscription row.
 * Pure function of (current row, snapshot, eventAt); safe to call from a
 * webhook, a manual sync, or a test.
 */
export async function applyGatewayState(
  tx: TenantTx,
  sub: RzpSubscription,
  eventAt: Date,
  opts: { actorId?: string | null; source: "webhook" | "sync" } = { source: "webhook" },
): Promise<ApplyResult> {
  // Serialise per organisation: two *different* events for the same org can
  // arrive concurrently; without this both would read the same "before" state
  // and both would apply (double audit entries, lost ordering). The lock is
  // released when the surrounding transaction commits.
  await tx.$executeRaw`SELECT id FROM "Subscription" WHERE "organisationId" = ${tx.$orgId()} FOR UPDATE`;
  const row = await tx.subscription.findFirst({ where: { organisationId: tx.$orgId() } });
  if (!row) return { applied: false, reason: "no_subscription_row" };

  // Ignore events for a subscription that isn't (or is no longer) this org's.
  if (row.gatewaySubscriptionId && row.gatewaySubscriptionId !== sub.id) {
    return { applied: false, reason: "stale_subscription_id" };
  }
  if (row.gatewayEventAt && eventAt < row.gatewayEventAt) {
    return { applied: false, reason: "out_of_order" };
  }

  const { status, grantsTier } = mapStatus(sub.status);
  const planTier = tierForPlanId(sub.plan_id);
  // A subscription on an unknown plan never grants access.
  const tier: PlanTier = grantsTier && planTier ? planTier : "FREE";

  // A scheduled downgrade is fulfilled once the gateway reports the new plan.
  const pendingTier = row.pendingTier && row.pendingTier === planTier ? null : row.pendingTier;
  const cancelAtPeriodEnd = status === "CANCELED" ? false : row.cancelAtPeriodEnd;

  const updated = await tx.subscription.update({
    where: { organisationId: tx.$orgId() },
    data: {
      status,
      tier,
      pendingTier: status === "CANCELED" ? null : pendingTier,
      gatewaySubscriptionId: sub.id,
      gatewayPlanId: sub.plan_id,
      gatewayCustomerId: sub.customer_id ?? row.gatewayCustomerId,
      currentPeriodStart: sub.current_start ? new Date(sub.current_start * 1000) : row.currentPeriodStart,
      currentPeriodEnd: sub.current_end ? new Date(sub.current_end * 1000) : row.currentPeriodEnd,
      cancelAtPeriodEnd,
      gatewayEventAt: eventAt,
    },
  });

  if (row.tier !== updated.tier) {
    await audit(tx, {
      action: updated.tier === "FREE" && row.tier !== "FREE" ? "plan.canceled" : "plan.changed",
      actorId: opts.actorId ?? null,
      targetType: "subscription",
      targetId: updated.id,
      metadata: { from: row.tier, to: updated.tier, gatewayStatus: sub.status, source: opts.source },
    });
  }
  return { applied: true, tier: updated.tier, status: updated.status };
}

// ---------------------------------------------------------------------------
// Webhook processing
// ---------------------------------------------------------------------------

export type WebhookOutcome =
  | { ok: true; duplicate: boolean; applied: boolean; reason?: string }
  | { ok: false; status: 400 | 401; error: string };

export async function processWebhook(input: {
  rawBody: string;
  signature: string | null;
  eventId: string | null;
}): Promise<WebhookOutcome> {
  if (!verifyWebhookSignature(input.rawBody, input.signature)) {
    return { ok: false, status: 401, error: "invalid signature" };
  }
  if (!input.eventId) return { ok: false, status: 400, error: "missing x-razorpay-event-id" };

  let event: RzpWebhookEvent;
  try {
    event = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, status: 400, error: "invalid JSON" };
  }
  if (event?.entity !== "event" || typeof event.event !== "string") {
    return { ok: false, status: 400, error: "not an event" };
  }

  const sub = event.payload.subscription?.entity;
  const organisationId = sub ? orgIdFromNotes(sub.notes) : null;
  const eventRow = { eventId: input.eventId, type: event.event, payload: event as unknown as Prisma.InputJsonValue };

  try {
    // Events we can't attribute to an org are still recorded (once) for the audit trail.
    if (!sub || !organisationId) {
      await db.webhookEvent.create({ data: { ...eventRow, processedAt: new Date() } });
      return { ok: true, duplicate: false, applied: false, reason: sub ? "no organisationId in notes" : "no subscription in payload" };
    }

    // One transaction on the org-scoped client: idempotency insert + state change.
    // WebhookEvent is a global table, so it passes through the tenant scope untouched.
    const result = await tenantDb(organisationId).$transaction(async (tx) => {
      await tx.webhookEvent.create({ data: eventRow }); // <- duplicate deliveries fail here

      const applied = await applyGatewayState(tx, sub, new Date(event.created_at * 1000), { source: "webhook" });

      if (event.event === "payment.failed" || event.event === "subscription.pending" || event.event === "subscription.halted") {
        await audit(tx, {
          action: "payment.failed",
          targetType: "subscription",
          targetId: sub.id,
          metadata: {
            event: event.event,
            paymentId: event.payload.payment?.entity.id ?? null,
            reason: event.payload.payment?.entity.error_description ?? null,
          },
        });
      }

      await tx.webhookEvent.update({ where: { eventId: input.eventId! }, data: { processedAt: new Date() } });
      return applied;
    });

    // Notifications go out only after the transaction committed, and only for
    // the first delivery (duplicates never reach this point).
    if (result.applied) await notifyForEvent(event, organisationId, input.eventId, result);
    return { ok: true, duplicate: false, applied: result.applied, reason: result.reason };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: true, duplicate: true, applied: false, reason: "duplicate event" };
    }
    throw e;
  }
}

const FAILURE_EVENTS = new Set(["payment.failed", "subscription.pending", "subscription.halted"]);

async function notifyForEvent(event: RzpWebhookEvent, organisationId: string, eventId: string, result: ApplyResult) {
  const payment = event.payload.payment?.entity;
  const sub = event.payload.subscription?.entity;
  if (event.event === "subscription.charged" && payment && result.tier && result.tier !== "FREE") {
    await notifyReceipt({
      organisationId,
      tier: result.tier,
      amountPaise: payment.amount,
      paymentId: payment.id,
      periodEnd: sub?.current_end ? new Date(sub.current_end * 1000) : null,
    });
  } else if (FAILURE_EVENTS.has(event.event)) {
    const planTier = tierForPlanId(sub?.plan_id) ?? result.tier ?? "FREE";
    await notifyPaymentFailed({
      organisationId,
      tier: planTier,
      amountPaise: payment?.amount ?? null,
      reason: payment?.error_description ?? null,
      halted: event.event === "subscription.halted",
      eventId,
    });
  }
}

// ---------------------------------------------------------------------------
// Customer-initiated changes
// ---------------------------------------------------------------------------

const TERMINAL: SubscriptionStatus[] = ["CANCELED"];

/**
 * Free -> paid. Creates a Razorpay subscription and returns what Checkout needs.
 * Nothing is provisioned until the gateway confirms via webhook/sync.
 */
export async function startCheckout(orgDb: TenantDb, tier: PlanTier, actorId: string) {
  if (tier === "FREE") throw new ForbiddenError("Cannot check out the Free plan");
  const row = await orgDb.subscription.findFirstOrThrow();
  if (row.gatewaySubscriptionId && !TERMINAL.includes(row.status) && row.status !== "INCOMPLETE") {
    throw new ForbiddenError("This organisation already has a subscription — change plan instead");
  }

  const org = await db.organisation.findUniqueOrThrow({ where: { id: orgDb.$orgId() }, select: { slug: true } });
  const sub = (await razorpay().subscriptions.create({
    plan_id: planIdFor(tier),
    total_count: 120, // 10 years of monthly cycles; Razorpay requires a cap
    quantity: 1,
    customer_notify: 0,
    notes: { organisationId: orgDb.$orgId(), tier, slug: org.slug },
  })) as unknown as RzpSubscription;

  await orgDb.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { organisationId: tx.$orgId() },
      data: { gatewaySubscriptionId: sub.id, gatewayPlanId: sub.plan_id, status: "INCOMPLETE" },
    });
    await audit(tx, {
      action: "plan.checkout_started",
      actorId,
      targetType: "subscription",
      targetId: sub.id,
      metadata: { tier },
    });
  });

  return { subscriptionId: sub.id, keyId: process.env.RAZORPAY_KEY_ID!, tier, plan: PLANS[tier] };
}

/**
 * Paid -> paid. Upgrades apply now (Razorpay prorates); downgrades are
 * scheduled for the end of the current cycle so the customer keeps what they
 * paid for. The tier only changes when the gateway reports it.
 */
export async function changePlan(orgDb: TenantDb, to: PlanTier, actorId: string) {
  const row = await orgDb.subscription.findFirstOrThrow();
  if (!row.gatewaySubscriptionId || row.tier === "FREE" || TERMINAL.includes(row.status)) {
    throw new ForbiddenError("No active subscription to change — start a checkout instead");
  }
  if (to === "FREE") return cancelSubscription(orgDb, actorId);
  if (to === row.tier && !row.pendingTier) throw new ForbiddenError("Already on this plan");

  const upgrade = isUpgrade(row.tier, to);
  await razorpay().subscriptions.update(row.gatewaySubscriptionId, {
    plan_id: planIdFor(to),
    schedule_change_at: upgrade ? "now" : "cycle_end",
    customer_notify: 0,
  });

  await orgDb.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { organisationId: tx.$orgId() },
      data: { pendingTier: upgrade ? null : to, cancelAtPeriodEnd: false },
    });
    await audit(tx, {
      action: "plan.change_scheduled",
      actorId,
      targetType: "subscription",
      targetId: row.gatewaySubscriptionId!,
      metadata: { from: row.tier, to, when: upgrade ? "now" : "cycle_end" },
    });
  });
  return { scheduled: !upgrade };
}

/** Paid -> Free at the end of the current cycle. */
export async function cancelSubscription(orgDb: TenantDb, actorId: string) {
  const row = await orgDb.subscription.findFirstOrThrow();
  if (!row.gatewaySubscriptionId || TERMINAL.includes(row.status)) {
    throw new ForbiddenError("Nothing to cancel");
  }
  await razorpay().subscriptions.cancel(row.gatewaySubscriptionId, true /* cancel_at_cycle_end */);
  await orgDb.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { organisationId: tx.$orgId() },
      data: { cancelAtPeriodEnd: true, pendingTier: "FREE" },
    });
    await audit(tx, {
      action: "plan.change_scheduled",
      actorId,
      targetType: "subscription",
      targetId: row.gatewaySubscriptionId!,
      metadata: { from: row.tier, to: "FREE", when: "cycle_end" },
    });
  });
  return { scheduled: true };
}

/**
 * Pulls the current subscription from Razorpay and applies it. Used as a
 * fallback when webhooks can't reach the dev machine, and as a "refresh"
 * button. Goes through the same `applyGatewayState` as webhooks.
 */
export async function syncFromGateway(orgDb: TenantDb, actorId: string | null) {
  const row = await orgDb.subscription.findFirstOrThrow();
  if (!row.gatewaySubscriptionId) return { applied: false, reason: "no gateway subscription" };
  const sub = (await razorpay().subscriptions.fetch(row.gatewaySubscriptionId)) as unknown as RzpSubscription;
  return orgDb.$transaction((tx) => applyGatewayState(tx, sub, new Date(), { actorId, source: "sync" }));
}
