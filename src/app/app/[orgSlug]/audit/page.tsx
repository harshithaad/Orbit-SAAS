import { requireOrg } from "@/lib/org";
import { requireCan } from "@/lib/permissions";
import { effectiveTier, hasFeature } from "@/lib/plans";
import { FeatureGate } from "@/components/feature-gate";
import { Card } from "@/components/ui";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ params }: PageProps<"/app/[orgSlug]/audit">) {
  const { orgSlug } = await params;
  const ctx = await requireOrg(orgSlug);
  requireCan(ctx, "audit:read");
  const tier = await effectiveTier(ctx.db);

  // Only load rows when the plan includes the feature (the gate below is UI).
  const rows = hasFeature(tier, "audit_log")
    ? await ctx.db.auditLog.findMany({
        include: { actor: { select: { email: true } } },
        orderBy: { createdAt: "desc" },
        take: 100,
      })
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-zinc-500">Sensitive actions in this organisation, newest first.</p>
      </div>

      <FeatureGate tier={tier} feature="audit_log" orgSlug={orgSlug}>
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-6 py-3">When</th>
                <th className="px-6 py-3">Actor</th>
                <th className="px-6 py-3">Action</th>
                <th className="px-6 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap px-6 py-2 text-zinc-500">{r.createdAt.toLocaleString()}</td>
                  <td className="px-6 py-2">{r.actor?.email ?? <span className="text-zinc-400">system</span>}</td>
                  <td className="px-6 py-2 font-mono text-xs">{r.action}</td>
                  <td className="px-6 py-2 font-mono text-xs text-zinc-500">
                    {r.metadata ? JSON.stringify(r.metadata) : ""}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-6 text-center text-zinc-500">
                    Nothing yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </FeatureGate>
    </div>
  );
}
