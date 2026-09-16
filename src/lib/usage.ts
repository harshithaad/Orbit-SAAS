import type { PlanTier } from "@/generated/prisma/enums";
import type { TenantDb, TenantTx } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { effectiveTier, limitFor } from "@/lib/plans";
import { METRICS, type Metric, type MetricLimit } from "@/config/plans";

/**
 * Usage metering.
 *
 * One `UsageRecord` row per (org, metric, period). Monthly metrics use the
 * first of the current UTC month as `periodStart`; lifetime metrics use the
 * epoch so there is exactly one row forever.
 *
 * `consume()` is the only write path. It runs in a transaction, locks the
 * org's row for that metric (upsert + FOR UPDATE), compares against the plan's
 * hard limit and either increments or throws `UsageLimitError`. Two concurrent
 * requests therefore cannot both slip under the cap.
 *
 * "Lifetime" metrics that track live rows (members, projects) are reconciled
 * from the actual count so deletions free up quota.
 */

export class UsageLimitError extends ForbiddenError {
  constructor(
    public readonly metric: Metric,
    public readonly limit: number,
    public readonly tier: PlanTier,
  ) {
    super(`${metric} limit of ${limit} reached on the ${tier} plan`);
    this.name = "UsageLimitError";
  }
}

export const EPOCH = new Date(0);

export function periodStartFor(limit: MetricLimit, now = new Date()): Date {
  if (limit.period === "lifetime") return EPOCH;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type UsageStatus = {
  metric: Metric;
  used: number;
  soft: number | null;
  hard: number | null;
  period: MetricLimit["period"];
  periodStart: Date;
  /** 0–1 of hard limit; null when unlimited. */
  fraction: number | null;
  level: "ok" | "warning" | "blocked";
};

function level(used: number, l: MetricLimit): UsageStatus["level"] {
  if (l.hard !== null && used >= l.hard) return "blocked";
  if (l.soft !== null && used >= l.soft) return "warning";
  return "ok";
}

/** Live count for metrics that mirror real rows; null for pure counters. */
async function liveCount(db: TenantTx, metric: Metric): Promise<number | null> {
  switch (metric) {
    case "members":
      return db.membership.count({ where: { organisationId: db.$orgId() } });
    case "projects":
      return db.project.count({ where: { organisationId: db.$orgId() } });
    default:
      return null;
  }
}

async function readCounter(db: TenantTx, metric: Metric, periodStart: Date): Promise<number> {
  const row = await db.usageRecord.findUnique({
    where: { organisationId_metric_periodStart: { organisationId: db.$orgId(), metric, periodStart } },
    select: { count: true },
  });
  return row?.count ?? 0;
}

/** Current usage for one metric (read-only). */
export async function usageFor(db: TenantTx, metric: Metric, tier?: PlanTier, now = new Date()): Promise<UsageStatus> {
  const t = tier ?? (await effectiveTier(db));
  const l = limitFor(t, metric);
  const periodStart = periodStartFor(l, now);
  const used = (await liveCount(db, metric)) ?? (await readCounter(db, metric, periodStart));
  return {
    metric,
    used,
    soft: l.soft,
    hard: l.hard,
    period: l.period,
    periodStart,
    fraction: l.hard === null ? null : Math.min(1, used / l.hard),
    level: level(used, l),
  };
}

/** Usage for every metric — the dashboard. */
export async function usageSummary(db: TenantTx, now = new Date()) {
  const tier = await effectiveTier(db);
  const metrics = await Promise.all(METRICS.map((m) => usageFor(db, m, tier, now)));
  return { tier, metrics };
}

/**
 * Reserves `amount` units of `metric`, or throws `UsageLimitError` if that
 * would exceed the hard limit. Call this inside the transaction that performs
 * the metered action so the reservation rolls back with it.
 *
 * Returns the resulting status so callers can surface soft-limit warnings.
 */
export async function consume(tx: TenantTx, metric: Metric, amount = 1, now = new Date()): Promise<UsageStatus> {
  const tier = await effectiveTier(tx);
  const l = limitFor(tier, metric);
  const periodStart = periodStartFor(l, now);
  const org = tx.$orgId();

  // Ensure the row exists, then lock it so concurrent consumers serialise.
  await tx.usageRecord.upsert({
    where: { organisationId_metric_periodStart: { organisationId: org, metric, periodStart } },
    update: {},
    create: { organisationId: org, metric, periodStart, count: 0 },
  });
  await tx.$executeRaw`SELECT id FROM "UsageRecord" WHERE "organisationId" = ${org} AND metric = ${metric} AND "periodStart" = ${periodStart} FOR UPDATE`;

  // For row-backed metrics the truth is the live count (deletes free quota).
  const current = (await liveCount(tx, metric)) ?? (await readCounter(tx, metric, periodStart));

  if (l.hard !== null && current + amount > l.hard) {
    throw new UsageLimitError(metric, l.hard, tier);
  }

  const row = await tx.usageRecord.update({
    where: { organisationId_metric_periodStart: { organisationId: org, metric, periodStart } },
    data: { count: { increment: amount } },
    select: { count: true },
  });

  const used = (await liveCount(tx, metric)) !== null ? current + amount : row.count;
  return {
    metric,
    used,
    soft: l.soft,
    hard: l.hard,
    period: l.period,
    periodStart,
    fraction: l.hard === null ? null : Math.min(1, used / l.hard),
    level: level(used, l),
  };
}

/** Convenience for non-transactional callers. */
export function consumeNow(db: TenantDb, metric: Metric, amount = 1) {
  return db.$transaction((tx) => consume(tx, metric, amount));
}
