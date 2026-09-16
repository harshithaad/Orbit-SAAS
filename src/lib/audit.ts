import type { TenantTx } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/** Sensitive actions that are recorded in the audit log. */
export type AuditAction =
  | "organisation.created"
  | "organisation.deleted"
  | "member.invited"
  | "member.invite_revoked"
  | "member.joined"
  | "member.role_changed"
  | "member.removed"
  | "plan.checkout_started"
  | "plan.change_scheduled"
  | "plan.changed"
  | "plan.canceled"
  | "payment.failed"
  | "project.deleted";

export type AuditEntry = {
  action: AuditAction;
  actorId?: string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
};

/**
 * Records a sensitive action against the org the client is bound to.
 * Pass a transaction client (`tx`) to make the entry atomic with the action.
 */
export function audit(db: TenantTx, entry: AuditEntry) {
  return db.auditLog.create({
    data: {
      organisationId: db.$orgId(),
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      metadata: entry.metadata,
    },
  });
}
