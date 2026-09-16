import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db, tenantDb } from "@/lib/db";
import type { Role } from "@/generated/prisma/enums";

/**
 * Request-scoped identity and tenant resolution.
 *
 * Every server component, server action and route handler that touches
 * tenant data goes through `requireOrg(slug)`. It:
 *   1. requires a signed-in user,
 *   2. looks up the org by slug,
 *   3. requires a Membership row for (user, org) — this is the ONLY place
 *      an organisationId is ever derived from,
 *   4. returns a `tenantDb` bound to that organisationId.
 *
 * Nothing downstream accepts an organisationId from request input.
 */

export class AuthError extends Error {
  constructor(message = "Not authenticated") {
    super(message);
    this.name = "AuthError";
  }
}
export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export const getUser = cache(async () => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  return db.user.findUnique({ where: { id } });
});

export async function requireUser() {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

export type OrgContext = {
  user: NonNullable<Awaited<ReturnType<typeof getUser>>>;
  org: { id: string; name: string; slug: string };
  role: Role;
  db: ReturnType<typeof tenantDb>;
};

export const getOrgContext = cache(async (slug: string): Promise<OrgContext | null> => {
  const user = await getUser();
  if (!user) return null;

  const org = await db.organisation.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true },
  });
  if (!org) return null;

  const membership = await db.membership.findUnique({
    where: { organisationId_userId: { organisationId: org.id, userId: user.id } },
    select: { role: true },
  });
  if (!membership) return null;

  return { user, org, role: membership.role, db: tenantDb(org.id) };
});

/** For pages: redirects instead of throwing. */
export async function requireOrg(slug: string): Promise<OrgContext> {
  const user = await getUser();
  if (!user) redirect("/login");
  const ctx = await getOrgContext(slug);
  if (!ctx) redirect("/app");
  return ctx;
}

/** For server actions / route handlers: throws typed errors. */
export async function requireOrgOrThrow(slug: string): Promise<OrgContext> {
  const user = await getUser();
  if (!user) throw new AuthError();
  const ctx = await getOrgContext(slug);
  if (!ctx) throw new ForbiddenError("Not a member of this organisation");
  return ctx;
}

/**
 * All orgs the current user belongs to (for the switcher). Loaded through the
 * User relation, which is the one legitimate cross-tenant read: "my memberships".
 */
export async function listUserOrgs(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      memberships: {
        select: { role: true, organisation: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  return (user?.memberships ?? []).map((m) => ({ ...m.organisation, role: m.role }));
}
