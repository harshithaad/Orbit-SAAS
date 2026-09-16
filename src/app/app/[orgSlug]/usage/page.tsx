import Link from "next/link";
import { requireOrg } from "@/lib/org";
import { usageSummary } from "@/lib/usage";
import { PLANS } from "@/config/plans";
import { Card } from "@/components/ui";
import { UsageBars } from "@/components/usage-bars";
import { PingButton } from "./client";

export const metadata = { title: "Usage" };

export default async function UsagePage({ params }: PageProps<"/app/[orgSlug]/usage">) {
  const { orgSlug } = await params;
  const ctx = await requireOrg(orgSlug);
  const { tier, metrics } = await usageSummary(ctx.db);
  const anyBlocked = metrics.some((m) => m.level === "blocked");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Usage</h1>
        <p className="text-sm text-zinc-500">
          Quota on the <span className="font-medium">{PLANS[tier].name}</span> plan.{" "}
          <Link href={`/app/${orgSlug}/billing`} className="underline">
            Change plan
          </Link>
        </p>
      </div>

      {anyBlocked && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          One or more limits have been reached. Metered actions are blocked until you free up quota or upgrade.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <UsageBars metrics={metrics} />
        </Card>
        <Card>
          <h2 className="font-medium">Try the metered API</h2>
          <p className="mt-1 mb-4 text-sm text-zinc-500">
            <code className="text-xs">POST /api/v1/ping</code> consumes one API call from this month&apos;s quota.
          </p>
          <PingButton orgSlug={orgSlug} />
        </Card>
      </div>
    </div>
  );
}
