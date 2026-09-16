"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Role } from "@/generated/prisma/enums";
import { requireOrgOrThrow, ForbiddenError } from "@/lib/org";
import { assertCan } from "@/lib/permissions";
import { createInvitation, revokeInvitation } from "@/lib/invites";
import { changeMemberRole, removeMember } from "@/lib/members";

export type ActionState = { error?: string; ok?: boolean; inviteUrl?: string };

const roleSchema = z.enum([Role.OWNER, Role.ADMIN, Role.MEMBER]);

function fail(e: unknown): ActionState {
  if (e instanceof ForbiddenError) return { error: e.message };
  console.error(e);
  return { error: "Something went wrong." };
}

export async function inviteMemberAction(
  orgSlug: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireOrgOrThrow(orgSlug);
    assertCan(ctx, "member:invite");

    const parsed = z
      .object({ email: z.email(), role: roleSchema.exclude([Role.OWNER]) })
      .safeParse({ email: fd.get("email"), role: fd.get("role") });
    if (!parsed.success) return { error: "Enter a valid email and role (admin or member)." };

    const { url } = await createInvitation(ctx.db, { ...parsed.data, invitedById: ctx.user.id });
    revalidatePath(`/app/${orgSlug}/members`);
    // Email delivery is wired in Phase 7; until then the link is shown in the UI.
    return { ok: true, inviteUrl: url };
  } catch (e) {
    return fail(e);
  }
}

export async function revokeInviteAction(orgSlug: string, invitationId: string): Promise<ActionState> {
  try {
    const ctx = await requireOrgOrThrow(orgSlug);
    assertCan(ctx, "member:invite");
    await revokeInvitation(ctx.db, invitationId, ctx.user.id);
    revalidatePath(`/app/${orgSlug}/members`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function changeRoleAction(
  orgSlug: string,
  targetUserId: string,
  role: string,
): Promise<ActionState> {
  try {
    const ctx = await requireOrgOrThrow(orgSlug);
    const newRole = roleSchema.parse(role);
    await changeMemberRole(ctx.db, { id: ctx.user.id, role: ctx.role }, targetUserId, newRole);
    revalidatePath(`/app/${orgSlug}/members`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function removeMemberAction(orgSlug: string, targetUserId: string): Promise<ActionState> {
  try {
    const ctx = await requireOrgOrThrow(orgSlug);
    await removeMember(ctx.db, { id: ctx.user.id, role: ctx.role }, targetUserId);
    revalidatePath(`/app/${orgSlug}/members`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
