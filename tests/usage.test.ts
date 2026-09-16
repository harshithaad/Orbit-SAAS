import { beforeEach, describe, expect, it } from "vitest";
import { EPOCH, UsageLimitError, consume, consumeNow, periodStartFor, usageFor, usageSummary } from "@/lib/usage";
import { PLANS } from "@/config/plans";
import { createOrg, createUser, resetDb, tenantDb, testDb } from "./helpers";

async function setup(tier: "FREE" | "PRO" | "TEAM" = "FREE") {
  const org = await createOrg();
  await testDb().subscription.create({ data: { organisationId: org.id, tier, status: "ACTIVE" } });
  return { org, orgDb: tenantDb(org.id) };
}

describe("periods", () => {
  it("monthly metrics key on the first of the UTC month; lifetime on the epoch", () => {
    const now = new Date("2026-09-16T23:59:59Z");
    expect(periodStartFor({ hard: 1, soft: 1, period: "monthly" }, now).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(periodStartFor({ hard: 1, soft: 1, period: "lifetime" }, now)).toEqual(EPOCH);
  });
});

describe("consume()", () => {
  beforeEach(resetDb);

  it("increments a monthly counter and reports soft/hard levels", async () => {
    const { orgDb } = await setup("FREE"); // api_calls: soft 80, hard 100
    let s = await consumeNow(orgDb, "api_calls", 79);
    expect(s).toMatchObject({ used: 79, level: "ok" });
    s = await consumeNow(orgDb, "api_calls", 1);
    expect(s).toMatchObject({ used: 80, level: "warning" });
    s = await consumeNow(orgDb, "api_calls", 20);
    expect(s).toMatchObject({ used: 100, level: "blocked", fraction: 1 });
  });

  it("blocks at the hard limit and rolls back the transaction", async () => {
    const { orgDb } = await setup("FREE");
    await consumeNow(orgDb, "api_calls", 100);
    await expect(consumeNow(orgDb, "api_calls", 1)).rejects.toBeInstanceOf(UsageLimitError);
    expect((await usageFor(orgDb, "api_calls")).used).toBe(100);

    // A metered action inside the same transaction is undone with it.
    await expect(
      orgDb.$transaction(async (tx) => {
        await tx.project.create({ data: { organisationId: tx.$orgId(), name: "should not persist" } });
        await consume(tx, "api_calls", 1);
      }),
    ).rejects.toBeInstanceOf(UsageLimitError);
    expect(await orgDb.project.count()).toBe(0);
  });

  it("row-backed metrics use the live count, so deletes free quota", async () => {
    const { orgDb } = await setup("FREE"); // projects hard 3
    for (let i = 0; i < 3; i++) {
      await orgDb.$transaction(async (tx) => {
        await consume(tx, "projects");
        await tx.project.create({ data: { organisationId: tx.$orgId(), name: `p${i}` } });
      });
    }
    await expect(consumeNow(orgDb, "projects")).rejects.toBeInstanceOf(UsageLimitError);

    await orgDb.project.deleteMany({ where: { name: "p0" } });
    await expect(consumeNow(orgDb, "projects")).resolves.toMatchObject({ used: 3 });
  });

  it("unlimited metrics never block", async () => {
    const { orgDb } = await setup("TEAM"); // projects unlimited
    const s = await consumeNow(orgDb, "projects", 10_000);
    expect(s).toMatchObject({ hard: null, fraction: null, level: "ok" });
  });

  it("concurrent consumers cannot exceed the hard limit", async () => {
    const { orgDb } = await setup("FREE"); // api_calls hard 100
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => consumeNow(orgDb, "api_calls", 10)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const blocked = results.filter((r) => r.status === "rejected").length;
    expect(ok).toBe(10);
    expect(blocked).toBe(10);
    expect((await usageFor(orgDb, "api_calls")).used).toBe(100);
  });

  it("counters reset each month", async () => {
    const { orgDb } = await setup("FREE");
    const aug = new Date("2026-08-15T00:00:00Z");
    const sep = new Date("2026-09-15T00:00:00Z");
    await orgDb.$transaction((tx) => consume(tx, "api_calls", 100, aug));
    await expect(orgDb.$transaction((tx) => consume(tx, "api_calls", 1, aug))).rejects.toBeInstanceOf(UsageLimitError);
    await expect(orgDb.$transaction((tx) => consume(tx, "api_calls", 1, sep))).resolves.toMatchObject({ used: 1 });
  });

  it("limits follow the org's effective tier", async () => {
    const { org, orgDb } = await setup("PRO"); // api_calls hard 2000
    await consumeNow(orgDb, "api_calls", 500);
    await testDb().subscription.update({ where: { organisationId: org.id }, data: { status: "CANCELED" } });
    // Degraded to FREE (hard 100): already over, so the next call is blocked.
    await expect(consumeNow(orgDb, "api_calls", 1)).rejects.toMatchObject({ tier: "FREE", limit: 100 });
  });

  it("usage is isolated per organisation", async () => {
    const a = await setup("FREE");
    const b = await setup("FREE");
    await consumeNow(a.orgDb, "api_calls", 100);
    expect((await usageFor(b.orgDb, "api_calls")).used).toBe(0);
    await expect(consumeNow(b.orgDb, "api_calls", 1)).resolves.toMatchObject({ used: 1 });
  });
});

describe("usageSummary()", () => {
  beforeEach(resetDb);

  it("reports every metric with the plan's limits", async () => {
    const { org, orgDb } = await setup("FREE");
    const u = await createUser();
    await testDb().membership.create({ data: { organisationId: org.id, userId: u.id, role: "OWNER" } });
    const s = await usageSummary(orgDb);
    expect(s.tier).toBe("FREE");
    const byMetric = Object.fromEntries(s.metrics.map((m) => [m.metric, m]));
    expect(byMetric.members).toMatchObject({ used: 1, hard: PLANS.FREE.limits.members.hard });
    expect(byMetric.projects).toMatchObject({ used: 0, hard: 3 });
    expect(byMetric.api_calls).toMatchObject({ used: 0, hard: 100, period: "monthly" });
  });
});
