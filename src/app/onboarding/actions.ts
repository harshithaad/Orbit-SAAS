"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/org";
import { slugify } from "@/lib/slug";

const schema = z.object({ name: z.string().trim().min(2).max(60) });

export type CreateOrgState = { error?: string };

/**
 * Creates an organisation and makes the caller its OWNER, in one transaction.
 * A FREE subscription row is created alongside so billing code can always
 * assume one exists.
 */
export async function createOrganisation(
  _prev: CreateOrgState,
  formData: FormData,
): Promise<CreateOrgState> {
  const user = await requireUser();
  const parsed = schema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: "Name must be 2–60 characters." };

  const base = slugify(parsed.data.name) || "org";
  let slug = base;
  for (let i = 2; await db.organisation.findUnique({ where: { slug } }); i++) {
    slug = `${base}-${i}`;
  }

  const org = await db.$transaction(async (tx) => {
    const org = await tx.organisation.create({ data: { name: parsed.data.name, slug } });
    await tx.membership.create({
      data: { organisationId: org.id, userId: user.id, role: "OWNER" },
    });
    await tx.subscription.create({ data: { organisationId: org.id, tier: "FREE" } });
    await tx.auditLog.create({
      data: {
        organisationId: org.id,
        actorId: user.id,
        action: "organisation.created",
        targetType: "organisation",
        targetId: org.id,
      },
    });
    return org;
  });

  redirect(`/app/${org.slug}`);
}
