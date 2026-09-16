"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgOrThrow } from "@/lib/org";
import { ForbiddenError } from "@/lib/errors";
import { assertCan } from "@/lib/permissions";
import { audit } from "@/lib/audit";

export type ActionState = { error?: string; ok?: boolean };

function fail(e: unknown): ActionState {
  if (e instanceof ForbiddenError) return { error: e.message };
  console.error(e);
  return { error: "Something went wrong." };
}

export async function createProjectAction(
  orgSlug: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireOrgOrThrow(orgSlug);
    assertCan(ctx, "project:create");
    const parsed = z
      .object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).optional() })
      .safeParse({ name: fd.get("name"), description: fd.get("description") || undefined });
    if (!parsed.success) return { error: "Name is required (max 80 chars)." };

    // Usage metering (plan limits) is applied here in Phase 6.
    await ctx.db.project.create({ data: { organisationId: ctx.org.id, ...parsed.data } });
    revalidatePath(`/app/${orgSlug}/projects`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteProjectAction(orgSlug: string, projectId: string): Promise<ActionState> {
  try {
    const ctx = await requireOrgOrThrow(orgSlug);
    assertCan(ctx, "project:delete");
    await ctx.db.$transaction(async (tx) => {
      const res = await tx.project.deleteMany({ where: { id: projectId } });
      if (res.count === 1) {
        await audit(tx, { action: "project.deleted", actorId: ctx.user.id, targetType: "project", targetId: projectId });
      }
    });
    revalidatePath(`/app/${orgSlug}/projects`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
