"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { PlanTier } from "@/generated/prisma/enums";
import { requireOrgOrThrow } from "@/lib/org";
import { ForbiddenError } from "@/lib/errors";
import { assertCan } from "@/lib/permissions";
import { cancelSubscription, changePlan, startCheckout, syncFromGateway } from "@/lib/billing";
import { verifyCheckoutSignature } from "@/lib/razorpay";

const tierSchema = z.enum([PlanTier.FREE, PlanTier.PRO, PlanTier.TEAM]);

export type CheckoutStart =
  | { ok: true; subscriptionId: string; keyId: string; name: string; description: string }
  | { ok: false; error: string };

function errorMessage(e: unknown): string {
  if (e instanceof ForbiddenError) return e.message;
  console.error(e);
  return "Something went wrong.";
}

/** Step 1 of Free -> paid: create the gateway subscription, return Checkout params. */
export async function startCheckoutAction(orgSlug: string, tier: string): Promise<CheckoutStart> {
  try {
    const ctx = await requireOrgOrThrow(orgSlug);
    assertCan(ctx, "billing:manage");
    const t = tierSchema.parse(tier);
    const r = await startCheckout(ctx.db, t, ctx.user.id);
    return {
      ok: true,
      subscriptionId: r.subscriptionId,
      keyId: r.keyId,
      name: "Orbit",
      description: `${r.plan.name} plan — ${ctx.org.name}`,
    };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/**
 * Step 2: Checkout succeeded in the browser. Verify Razorpay's signature over
 * payment_id|subscription_id, then pull the subscription state from the
 * gateway. (The webhook will also arrive; both paths are idempotent.)
 */
export async function confirmCheckoutAction(
  orgSlug: string,
  params: { paymentId: string; subscriptionId: string; signature: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const ctx = await requireOrgOrThrow(orgSlug);
    assertCan(ctx, "billing:manage");
    if (!verifyCheckoutSignature(params)) return { ok: false, error: "Payment signature did not verify." };
    const row = await ctx.db.subscription.findFirstOrThrow();
    if (row.gatewaySubscriptionId !== params.subscriptionId) {
      return { ok: false, error: "Subscription does not belong to this organisation." };
    }
    await syncFromGateway(ctx.db, ctx.user.id);
    revalidatePath(`/app/${orgSlug}`, "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function changePlanAction(orgSlug: string, tier: string): Promise<{ ok: boolean; error?: string; scheduled?: boolean }> {
  try {
    const ctx = await requireOrgOrThrow(orgSlug);
    assertCan(ctx, "billing:manage");
    const t = tierSchema.parse(tier);
    const r = await changePlan(ctx.db, t, ctx.user.id);
    revalidatePath(`/app/${orgSlug}/billing`);
    return { ok: true, scheduled: r.scheduled };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function cancelPlanAction(orgSlug: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const ctx = await requireOrgOrThrow(orgSlug);
    assertCan(ctx, "billing:manage");
    await cancelSubscription(ctx.db, ctx.user.id);
    revalidatePath(`/app/${orgSlug}/billing`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function syncPlanAction(orgSlug: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const ctx = await requireOrgOrThrow(orgSlug);
    assertCan(ctx, "billing:view");
    await syncFromGateway(ctx.db, ctx.user.id);
    revalidatePath(`/app/${orgSlug}`, "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}
