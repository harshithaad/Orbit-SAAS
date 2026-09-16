import { requireOrg } from "@/lib/org";
import { can, requireCan } from "@/lib/permissions";
import { FEATURES, FEATURE_LABELS, METRICS, METRIC_LABELS, PLANS, TIER_ORDER } from "@/config/plans";
import { effectiveTier } from "@/lib/plans";
import { isRazorpayConfigured } from "@/lib/razorpay";
import { Card } from "@/components/ui";
import { PlanButton, SyncButton } from "./client";

export const metadata = { title: "Billing" };

const STATUS_COPY: Record<string, string> = {
  ACTIVE: "Active",
  TRIALING: "Payment authorised — first charge processing",
  PAST_DUE: "Payment failed — Razorpay is retrying",
  UNPAID: "Payment failed — subscription halted",
  CANCELED: "Cancelled",
  INCOMPLETE: "Checkout not completed",
};

export default async function BillingPage({ params }: PageProps<"/app/[orgSlug]/billing">) {
  const { orgSlug } = await params;
  const ctx = await requireOrg(orgSlug);
  requireCan(ctx, "billing:view");

  const [sub, tier] = await Promise.all([ctx.db.subscription.findFirstOrThrow(), effectiveTier(ctx.db)]);
  const current = PLANS[tier];
  const configured = isRazorpayConfigured();
  const canManage = can(ctx.role, "billing:manage");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-sm text-zinc-500">Plans, limits and payment. Test mode — no real charges.</p>
      </div>

      <Card className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-zinc-500">Current plan</p>
          <p className="text-xl font-semibold">{current.name}</p>
          <p className="text-sm text-zinc-500">
            {STATUS_COPY[sub.status] ?? sub.status}
            {sub.tier !== tier && ` (${PLANS[sub.tier].name} subscription)`}
          </p>
          {sub.currentPeriodEnd && (
            <p className="text-sm text-zinc-500">
              {sub.pendingTier
                ? `Switches to ${PLANS[sub.pendingTier].name} on ${sub.currentPeriodEnd.toLocaleDateString()}`
                : `Renews on ${sub.currentPeriodEnd.toLocaleDateString()}`}
            </p>
          )}
        </div>
        <div className="text-right text-xs text-zinc-500">
          {sub.gatewaySubscriptionId && (
            <>
              <p className="font-mono">{sub.gatewaySubscriptionId}</p>
              <SyncButton orgSlug={orgSlug} />
            </>
          )}
          {!configured && <p>Razorpay keys not set — billing disabled.</p>}
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {TIER_ORDER.map((t) => {
          const p = PLANS[t];
          const isCurrent = t === tier;
          return (
            <Card key={t} className={isCurrent ? "ring-2 ring-zinc-900" : ""}>
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-semibold">{p.name}</h2>
                <p className="text-sm">
                  <span className="text-2xl font-semibold">₹{p.priceMonthly.toLocaleString("en-IN")}</span>
                  <span className="text-zinc-500">/mo</span>
                </p>
              </div>
              <p className="mt-1 text-sm text-zinc-500">{p.description}</p>
              <ul className="mt-4 space-y-1 text-sm">
                {METRICS.map((m) => (
                  <li key={m} className="flex justify-between">
                    <span className="text-zinc-600">{METRIC_LABELS[m]}</span>
                    <span className="font-medium">
                      {p.limits[m].hard === null ? "Unlimited" : p.limits[m].hard.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
              <ul className="mt-4 space-y-1 border-t border-zinc-100 pt-3 text-sm">
                {FEATURES.map((f) => (
                  <li key={f} className={p.features[f] ? "" : "text-zinc-400 line-through"}>
                    {p.features[f] ? "✓" : "–"} {FEATURE_LABELS[f]}
                  </li>
                ))}
              </ul>
              {isCurrent && !sub.pendingTier && (
                <p className="mt-4 rounded-md bg-zinc-100 py-1.5 text-center text-xs font-medium">Current plan</p>
              )}
              <PlanButton
                orgSlug={orgSlug}
                tier={t}
                currentTier={tier}
                hasGatewaySubscription={Boolean(sub.gatewaySubscriptionId) && sub.status !== "CANCELED" && sub.status !== "INCOMPLETE"}
                pendingTier={sub.pendingTier}
                canManage={canManage}
                configured={configured}
                email={ctx.user.email}
              />
            </Card>
          );
        })}
      </div>
    </div>
  );
}
