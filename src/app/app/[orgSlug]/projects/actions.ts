"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgOrThrow } from "@/lib/org";
import { ForbiddenError } from "@/lib/errors";
import { assertCan } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { UsageLimitError, consume } from "@/lib/usage";

export type ActionState = { error?: string; ok?: boolean; warning?: string; limitReached?: boolean };

function fail(e: unknown): ActionState {
  if (e instanceof UsageLimitError) {
    return { error: `You've reached the ${e.limit} ${e.metric} limit on the ${e.tier} plan.`, limitReached: true };
  }
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

    // Reserve quota and create in one transaction: if the limit is hit, nothing is written.
    const usage = await ctx.db.$transaction(async (tx) => {
      const u = await consume(tx, "projects");
      await tx.project.create({ data: { organisationId: tx.$orgId(), ...parsed.data } });
      return u;
    });
    revalidatePath(`/app/${orgSlug}/projects`);
    return {
      ok: true,
      warning:
        usage.level === "warning" && usage.hard !== null
          ? `${usage.used} of ${usage.hard} projects used on your plan.`
          : undefined,
    };
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
