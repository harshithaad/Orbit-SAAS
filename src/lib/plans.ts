import type { PlanTier } from "@/generated/prisma/enums";
import type { TenantTx } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { PLANS, TIER_ORDER, type Feature, type Metric, type MetricLimit } from "@/config/plans";

/**
 * Plan helpers. All feature/limit questions go through here so the answer
 * always comes from `config/plans.ts` and the org's Subscription row.
 */

export function planFor(tier: PlanTier) {
  return PLANS[tier];
}

export function hasFeature(tier: PlanTier, feature: Feature): boolean {
  return PLANS[tier].features[feature];
}

export function limitFor(tier: PlanTier, metric: Metric): MetricLimit {
  return PLANS[tier].limits[metric];
}

export function tierRank(tier: PlanTier): number {
  return TIER_ORDER.indexOf(tier);
}

export function isUpgrade(from: PlanTier, to: PlanTier): boolean {
  return tierRank(to) > tierRank(from);
}

/**
 * The org's effective tier. A subscription that is CANCELED / UNPAID /
 * INCOMPLETE grants Free-tier access regardless of the stored tier, so a
 * lapsed Pro org is limited but its data is never locked away.
 * PAST_DUE keeps its tier (Stripe is retrying payment; dunning emails go out).
 */
export async function effectiveTier(db: TenantTx): Promise<PlanTier> {
  const sub = await db.subscription.findFirst({
    where: { organisationId: db.$orgId() },
    select: { tier: true, status: true },
  });
  if (!sub) return "FREE";
  if (sub.status === "CANCELED" || sub.status === "UNPAID" || sub.status === "INCOMPLETE") {
    return "FREE";
  }
  return sub.tier;
}

export async function requireFeature(db: TenantTx, feature: Feature): Promise<PlanTier> {
  const tier = await effectiveTier(db);
  if (!hasFeature(tier, feature)) {
    throw new ForbiddenError(`Feature "${feature}" is not included in the ${PLANS[tier].name} plan`);
  }
  return tier;
}
