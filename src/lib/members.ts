import type { Role } from "@/generated/prisma/enums";
import type { TenantDb, TenantTx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { canChangeRole, canRemoveMember } from "@/lib/permissions";
import { ForbiddenError } from "@/lib/errors";

/**
 * Membership mutations. Each one re-reads the target and the owner count
 * inside a transaction so the "last owner" rule can't be raced.
 */

async function loadTarget(tx: TenantTx, userId: string) {
  const [target, ownerCount] = await Promise.all([
    tx.membership.findUnique({
      where: { organisationId_userId: { organisationId: tx.$orgId(), userId } },
    }),
    tx.membership.count({ where: { organisationId: tx.$orgId(), role: "OWNER" } }),
  ]);
  return { target, ownerCount };
}

export async function changeMemberRole(
  orgDb: TenantDb,
  actor: { id: string; role: Role },
  targetUserId: string,
  newRole: Role,
) {
  return orgDb.$transaction(async (tx) => {
    const { target, ownerCount } = await loadTarget(tx, targetUserId);
    if (!target) throw new ForbiddenError("Not a member");
    const allowed = canChangeRole({
      actorRole: actor.role,
      actorIsTarget: actor.id === targetUserId,
      targetRole: target.role,
      newRole,
      ownerCount,
    });
    if (!allowed) throw new ForbiddenError("Cannot change this member's role");
    if (target.role === newRole) return target;

    const updated = await tx.membership.update({
      where: { organisationId_userId: { organisationId: tx.$orgId(), userId: targetUserId } },
      data: { role: newRole },
    });
    await audit(tx, {
      action: "member.role_changed",
      actorId: actor.id,
      targetType: "membership",
      targetId: targetUserId,
      metadata: { from: target.role, to: newRole },
    });
    return updated;
  });
}

export async function removeMember(
  orgDb: TenantDb,
  actor: { id: string; role: Role },
  targetUserId: string,
) {
  return orgDb.$transaction(async (tx) => {
    const { target, ownerCount } = await loadTarget(tx, targetUserId);
    if (!target) throw new ForbiddenError("Not a member");
    const allowed = canRemoveMember({
      actorRole: actor.role,
      actorIsTarget: actor.id === targetUserId,
      targetRole: target.role,
      ownerCount,
    });
    if (!allowed) throw new ForbiddenError("Cannot remove this member");

    await tx.membership.delete({
      where: { organisationId_userId: { organisationId: tx.$orgId(), userId: targetUserId } },
    });
    await audit(tx, {
      action: "member.removed",
      actorId: actor.id,
      targetType: "membership",
      targetId: targetUserId,
      metadata: { role: target.role, self: actor.id === targetUserId },
    });
  });
}
