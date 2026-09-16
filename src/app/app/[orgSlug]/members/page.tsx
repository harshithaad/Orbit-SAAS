import { requireOrg } from "@/lib/org";
import { can, canChangeRole, canRemoveMember } from "@/lib/permissions";
import { Card } from "@/components/ui";
import { InviteForm, MemberRow, PendingInviteRow } from "./client";

export const metadata = { title: "Members" };

export default async function MembersPage({ params }: PageProps<"/app/[orgSlug]/members">) {
  const { orgSlug } = await params;
  const ctx = await requireOrg(orgSlug);

  const [members, invites] = await Promise.all([
    ctx.db.membership.findMany({
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    ctx.db.invitation.findMany({
      where: { status: "PENDING", expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const ownerCount = members.filter((m) => m.role === "OWNER").length;
  const canInvite = can(ctx.role, "member:invite");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Members</h1>
        <p className="text-sm text-zinc-500">
          {members.length} member{members.length === 1 ? "" : "s"} · you are{" "}
          <span className="font-medium">{ctx.role.toLowerCase()}</span>
        </p>
      </div>

      <Card className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-6 py-3">User</th>
              <th className="px-6 py-3">Role</th>
              <th className="px-6 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {members.map((m) => {
              const isSelf = m.userId === ctx.user.id;
              const roleOptions = (["OWNER", "ADMIN", "MEMBER"] as const).filter((r) =>
                canChangeRole({
                  actorRole: ctx.role,
                  actorIsTarget: isSelf,
                  targetRole: m.role,
                  newRole: r,
                  ownerCount,
                }),
              );
              const removable = canRemoveMember({
                actorRole: ctx.role,
                actorIsTarget: isSelf,
                targetRole: m.role,
                ownerCount,
              });
              return (
                <MemberRow
                  key={m.id}
                  orgSlug={orgSlug}
                  userId={m.userId}
                  email={m.user.email}
                  name={m.user.name}
                  role={m.role}
                  isSelf={isSelf}
                  roleOptions={roleOptions}
                  removable={removable}
                />
              );
            })}
          </tbody>
        </table>
      </Card>

      {canInvite && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <h2 className="mb-1 font-medium">Invite a teammate</h2>
            <p className="mb-4 text-sm text-zinc-500">
              Links are signed and expire in 7 days. One live link per email.
            </p>
            <InviteForm orgSlug={orgSlug} />
          </Card>
          <Card>
            <h2 className="mb-4 font-medium">Pending invitations</h2>
            {invites.length === 0 ? (
              <p className="text-sm text-zinc-500">None.</p>
            ) : (
              <ul className="divide-y divide-zinc-100 text-sm">
                {invites.map((i) => (
                  <PendingInviteRow
                    key={i.id}
                    orgSlug={orgSlug}
                    id={i.id}
                    email={i.email}
                    role={i.role}
                    expiresAt={i.expiresAt.toISOString()}
                  />
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
