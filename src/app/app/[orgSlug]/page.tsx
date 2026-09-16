import { requireOrg } from "@/lib/org";
import { Card } from "@/components/ui";

export default async function OrgOverview({ params }: PageProps<"/app/[orgSlug]">) {
  const { orgSlug } = await params;
  const ctx = await requireOrg(orgSlug);

  // Every query below is automatically scoped to ctx.org.id.
  const [members, projects, subscription] = await Promise.all([
    ctx.db.membership.count(),
    ctx.db.project.count(),
    ctx.db.subscription.findFirst(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{ctx.org.name}</h1>
        <p className="text-sm text-zinc-500">/{ctx.org.slug}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Plan" value={subscription?.tier ?? "FREE"} />
        <Stat label="Members" value={members} />
        <Stat label="Projects" value={projects} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </Card>
  );
}
