import { beforeEach, describe, expect, it } from "vitest";
import { FEATURES, METRICS, PLANS, TIER_ORDER } from "@/config/plans";
import { effectiveTier, hasFeature, isUpgrade, limitFor, requireFeature } from "@/lib/plans";
import { ForbiddenError } from "@/lib/errors";
import { createOrg, resetDb, tenantDb, testDb } from "./helpers";

describe("plan config", () => {
  it("defines every feature and metric for every tier", () => {
    for (const tier of TIER_ORDER) {
      for (const f of FEATURES) expect(typeof PLANS[tier].features[f]).toBe("boolean");
      for (const m of METRICS) expect(PLANS[tier].limits[m]).toBeDefined();
    }
  });

  it("limits never decrease and features never disappear as you go up a tier", () => {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      const lower = PLANS[TIER_ORDER[i - 1]];
      const upper = PLANS[TIER_ORDER[i]];
      for (const m of METRICS) {
        const lo = lower.limits[m].hard;
        const hi = upper.limits[m].hard;
        if (hi !== null) expect(lo).not.toBeNull();
        if (lo !== null && hi !== null) expect(hi).toBeGreaterThanOrEqual(lo);
      }
      for (const f of FEATURES) {
        if (lower.features[f]) expect(upper.features[f]).toBe(true);
      }
    }
  });

  it("soft limits never exceed hard limits", () => {
    for (const tier of TIER_ORDER) {
      for (const m of METRICS) {
        const { soft, hard } = PLANS[tier].limits[m];
        if (soft !== null && hard !== null) expect(soft).toBeLessThanOrEqual(hard);
        if (hard === null) expect(soft).toBeNull();
      }
    }
  });

  it("paid tiers map to a Stripe price env var; Free does not", () => {
    expect(PLANS.FREE.stripePriceEnv).toBeNull();
    expect(PLANS.PRO.stripePriceEnv).toBe("STRIPE_PRICE_PRO");
    expect(PLANS.TEAM.stripePriceEnv).toBe("STRIPE_PRICE_TEAM");
  });
});

describe("plan helpers", () => {
  it("hasFeature / limitFor read the config", () => {
    expect(hasFeature("FREE", "audit_log")).toBe(false);
    expect(hasFeature("PRO", "audit_log")).toBe(true);
    expect(limitFor("FREE", "projects").hard).toBe(3);
    expect(limitFor("TEAM", "projects").hard).toBeNull();
  });

  it("isUpgrade follows tier order", () => {
    expect(isUpgrade("FREE", "PRO")).toBe(true);
    expect(isUpgrade("TEAM", "PRO")).toBe(false);
    expect(isUpgrade("PRO", "PRO")).toBe(false);
  });
});

describe("effectiveTier", () => {
  beforeEach(resetDb);

  it("falls back to FREE when there is no subscription row", async () => {
    const org = await createOrg();
    expect(await effectiveTier(tenantDb(org.id))).toBe("FREE");
  });

  it("returns the stored tier while ACTIVE or PAST_DUE", async () => {
    const org = await createOrg();
    await testDb().subscription.create({ data: { organisationId: org.id, tier: "PRO", status: "ACTIVE" } });
    expect(await effectiveTier(tenantDb(org.id))).toBe("PRO");
    await testDb().subscription.update({ where: { organisationId: org.id }, data: { status: "PAST_DUE" } });
    expect(await effectiveTier(tenantDb(org.id))).toBe("PRO");
  });

  it("degrades to FREE when CANCELED or UNPAID", async () => {
    const org = await createOrg();
    await testDb().subscription.create({ data: { organisationId: org.id, tier: "TEAM", status: "CANCELED" } });
    expect(await effectiveTier(tenantDb(org.id))).toBe("FREE");
    await expect(requireFeature(tenantDb(org.id), "sso")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("reads the subscription of the bound org only", async () => {
    const a = await createOrg();
    const b = await createOrg();
    await testDb().subscription.create({ data: { organisationId: b.id, tier: "TEAM", status: "ACTIVE" } });
    expect(await effectiveTier(tenantDb(a.id))).toBe("FREE");
    expect(await effectiveTier(tenantDb(b.id))).toBe("TEAM");
  });
});
