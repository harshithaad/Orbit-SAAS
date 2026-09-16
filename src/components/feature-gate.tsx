import Link from "next/link";
import type { PlanTier } from "@/generated/prisma/enums";
import { FEATURE_LABELS, PLANS, TIER_ORDER, type Feature } from "@/config/plans";
import { hasFeature } from "@/lib/plans";
import { Card } from "@/components/ui";

/** Lowest tier that includes `feature`, for "Upgrade to X" copy. */
export function minTierFor(feature: Feature): PlanTier {
  return TIER_ORDER.find((t) => PLANS[t].features[feature]) ?? "TEAM";
}

/**
 * Server component: renders children when the org's tier includes the
 * feature, otherwise an upgrade prompt. UI-only — the real gate is
 * `requireFeature()` in the server action / loader.
 */
export function FeatureGate({
  tier,
  feature,
  orgSlug,
  children,
}: {
  tier: PlanTier;
  feature: Feature;
  orgSlug: string;
  children: React.ReactNode;
}) {
  if (hasFeature(tier, feature)) return <>{children}</>;
  const needed = PLANS[minTierFor(feature)];
  return (
    <Card className="border-dashed text-center">
      <p className="text-2xl">🔒</p>
      <h2 className="mt-2 font-medium">{FEATURE_LABELS[feature]} is a {needed.name} feature</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Your organisation is on the {PLANS[tier].name} plan.
      </p>
      <Link
        href={`/app/${orgSlug}/billing`}
        className="mt-4 inline-block rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
      >
        Upgrade to {needed.name}
      </Link>
    </Card>
  );
}
