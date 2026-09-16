import type { Role } from "@/generated/prisma/enums";
import { forbidden } from "next/navigation";
import { ForbiddenError } from "@/lib/errors";
import type { OrgContext } from "@/lib/org";

/**
 * Role-based access control.
 *
 * ONE permission table, ONE check function. Nothing else in the codebase
 * compares roles directly — every server action, route handler and UI gate
 * calls `can()` / `assertCan()`.
 *
 * Roles are strictly ordered: OWNER ⊃ ADMIN ⊃ MEMBER.
 */

export const ACTIONS = [
  "org:read",
  "org:update",
  "org:delete",
  "member:invite",
  "member:remove",
  "member:change_role",
  "billing:view",
  "billing:manage",
  "project:create",
  "project:update",
  "project:delete",
  "audit:read",
] as const;

export type Action = (typeof ACTIONS)[number];

const RANK: Record<Role, number> = { MEMBER: 0, ADMIN: 1, OWNER: 2 };

/** Minimum role required for each action. */
const MIN_ROLE: Record<Action, Role> = {
  "org:read": "MEMBER",
  "org:update": "ADMIN",
  "org:delete": "OWNER",
  "member:invite": "ADMIN",
  "member:remove": "ADMIN",
  "member:change_role": "OWNER",
  "billing:view": "ADMIN",
  "billing:manage": "OWNER",
  "project:create": "MEMBER",
  "project:update": "MEMBER",
  "project:delete": "ADMIN",
  "audit:read": "ADMIN",
};

export function can(role: Role, action: Action): boolean {
  return RANK[role] >= RANK[MIN_ROLE[action]];
}

/** For server actions / route handlers: throws a typed error. */
export function assertCan(ctx: Pick<OrgContext, "role">, action: Action): void {
  if (!can(ctx.role, action)) {
    throw new ForbiddenError(`Role ${ctx.role} cannot ${action}`);
  }
}

/** For pages: renders the segment's forbidden.tsx (HTTP 403). */
export function requireCan(ctx: Pick<OrgContext, "role">, action: Action): void {
  if (!can(ctx.role, action)) forbidden();
}

/**
 * Role-change rules on top of `member:change_role`:
 *  - nobody can change their own role (prevents accidental lock-out),
 *  - only an OWNER can grant or revoke OWNER,
 *  - the last OWNER cannot be demoted or removed.
 * `ownerCount` is the current number of OWNER memberships in the org.
 */
export function canChangeRole(opts: {
  actorRole: Role;
  actorIsTarget: boolean;
  targetRole: Role;
  newRole: Role;
  ownerCount: number;
}): boolean {
  const { actorRole, actorIsTarget, targetRole, newRole, ownerCount } = opts;
  if (!can(actorRole, "member:change_role")) return false;
  if (actorIsTarget) return false;
  if ((targetRole === "OWNER" || newRole === "OWNER") && actorRole !== "OWNER") return false;
  if (targetRole === "OWNER" && newRole !== "OWNER" && ownerCount <= 1) return false;
  return true;
}

export function canRemoveMember(opts: {
  actorRole: Role;
  actorIsTarget: boolean;
  targetRole: Role;
  ownerCount: number;
}): boolean {
  const { actorRole, actorIsTarget, targetRole, ownerCount } = opts;
  // Anyone may leave, except the last owner.
  if (actorIsTarget) return !(targetRole === "OWNER" && ownerCount <= 1);
  if (!can(actorRole, "member:remove")) return false;
  // Admins can't remove owners; owners can't remove the last owner.
  if (targetRole === "OWNER") return actorRole === "OWNER" && ownerCount > 1;
  return true;
}
