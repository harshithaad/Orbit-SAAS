import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "@/generated/prisma/enums";
import { db, tenantDb, type TenantDb } from "@/lib/db";
import { audit } from "@/lib/audit";
import { UsageLimitError, consume } from "@/lib/usage";

/**
 * Signed, expiring invitation links.
 *
 * Link format:   /invite/<payload>.<signature>
 *   payload    = base64url(JSON { id, org, email, exp, nonce })
 *   signature  = base64url(HMAC-SHA256(INVITE_SECRET, payload))
 *
 * The database stores only sha256(token) as `tokenHash`, so a DB leak does
 * not expose usable links. Accepting requires:
 *   1. a valid signature (timing-safe compare),
 *   2. `exp` in the future,
 *   3. a PENDING row in org `org` whose tokenHash matches,
 *   4. the signed-in user's email to equal the invited email.
 */

export const INVITE_TTL_DAYS = 7;

function secret(): Buffer {
  const s = process.env.INVITE_SECRET;
  if (!s) throw new Error("INVITE_SECRET is not set");
  return Buffer.from(s, "utf8");
}

const b64u = {
  enc: (b: Buffer | string) => Buffer.from(b).toString("base64url"),
  dec: (s: string) => Buffer.from(s, "base64url"),
};

export type InvitePayload = { id: string; org: string; email: string; exp: number; nonce: string };

function sign(payload: string): string {
  return b64u.enc(createHmac("sha256", secret()).update(payload).digest());
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function buildInviteToken(p: InvitePayload): string {
  const payload = b64u.enc(JSON.stringify(p));
  return `${payload}.${sign(payload)}`;
}

export type VerifyResult =
  | { ok: true; payload: InvitePayload; tokenHash: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyInviteToken(token: string, now = Date.now()): VerifyResult {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }

  let parsed: InvitePayload;
  try {
    parsed = JSON.parse(b64u.dec(payload).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed?.id || !parsed?.org || !parsed?.email || typeof parsed.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (parsed.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, payload: parsed, tokenHash: hashToken(token) };
}

export function inviteUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base}/invite/${token}`;
}

/**
 * Creates a PENDING invitation for `email` and returns the one-time link.
 * Any existing PENDING invite for the same email in this org is revoked first,
 * so there is only ever one live link per (org, email).
 */
export async function createInvitation(
  orgDb: TenantDb,
  opts: { email: string; role: Role; invitedById: string },
) {
  const email = opts.email.trim().toLowerCase();
  const exp = Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
  const org = orgDb.$orgId();

  return orgDb.$transaction(async (tx) => {
    await tx.invitation.updateMany({
      where: { organisationId: org, email, status: "PENDING" },
      data: { status: "REVOKED" },
    });

    // Two-step create: the row id is part of the signed payload.
    const row = await tx.invitation.create({
      data: {
        organisationId: org,
        email,
        role: opts.role,
        invitedById: opts.invitedById,
        expiresAt: new Date(exp),
        tokenHash: `pending:${randomBytes(16).toString("hex")}`,
      },
    });
    const token = buildInviteToken({
      id: row.id,
      org,
      email,
      exp,
      nonce: randomBytes(8).toString("hex"),
    });
    const invitation = await tx.invitation.update({
      where: { id: row.id, organisationId: org },
      data: { tokenHash: hashToken(token) },
    });
    await audit(tx, {
      action: "member.invited",
      actorId: opts.invitedById,
      targetType: "invitation",
      targetId: row.id,
      metadata: { email, role: opts.role },
    });
    return { invitation, token, url: inviteUrl(token) };
  });
}

export async function revokeInvitation(orgDb: TenantDb, id: string, actorId: string) {
  return orgDb.$transaction(async (tx) => {
    const res = await tx.invitation.updateMany({
      where: { organisationId: orgDb.$orgId(), id, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    if (res.count === 1) {
      await audit(tx, {
        action: "member.invite_revoked",
        actorId,
        targetType: "invitation",
        targetId: id,
      });
    }
    return res.count === 1;
  });
}

export type InviteFailure =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "not_found"
  | "not_pending"
  | "email_mismatch"
  | "member_limit";

/**
 * Resolves a token to its invitation without side effects (for the accept
 * page). The org id comes from the *signed* payload, so the lookup is scoped
 * even though the caller has no membership yet.
 */
export async function previewInvitation(token: string) {
  const v = verifyInviteToken(token);
  if (!v.ok) return { ok: false as const, reason: v.reason as InviteFailure };

  const inv = await db.invitation.findFirst({
    where: { id: v.payload.id, organisationId: v.payload.org },
    include: { organisation: { select: { id: true, name: true, slug: true } } },
  });
  if (!inv || inv.tokenHash !== v.tokenHash) return { ok: false as const, reason: "not_found" as const };
  if (inv.status !== "PENDING") return { ok: false as const, reason: "not_pending" as const };
  return { ok: true as const, invitation: inv, payload: v.payload };
}

export type AcceptResult =
  | { ok: true; organisation: { id: string; name: string; slug: string }; role: Role }
  | { ok: false; reason: InviteFailure };

/** Accepts an invitation for `user`, creating the membership atomically. */
export async function acceptInvitation(
  token: string,
  user: { id: string; email: string },
): Promise<AcceptResult> {
  const p = await previewInvitation(token);
  if (!p.ok) return p;
  const inv = p.invitation;

  if (inv.email !== user.email.toLowerCase()) return { ok: false, reason: "email_mismatch" };

  const orgDb = tenantDb(inv.organisationId);
  try {
    await orgDb.$transaction(async (tx) => {
      // Flip PENDING -> ACCEPTED first; a concurrent accept sees count === 0.
      const flipped = await tx.invitation.updateMany({
        where: { organisationId: inv.organisationId, id: inv.id, status: "PENDING" },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });
      if (flipped.count !== 1) throw new Error("not_pending");

      // Plan seat limit — counted against live memberships.
      await consume(tx, "members");

      await tx.membership.upsert({
        where: { organisationId_userId: { organisationId: inv.organisationId, userId: user.id } },
        update: {},
        create: { organisationId: inv.organisationId, userId: user.id, role: inv.role },
      });
      await audit(tx, {
        action: "member.joined",
        actorId: user.id,
        targetType: "membership",
        targetId: user.id,
        metadata: { via: "invitation", invitationId: inv.id, role: inv.role },
      });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "not_pending") return { ok: false, reason: "not_pending" };
    if (e instanceof UsageLimitError) return { ok: false, reason: "member_limit" };
    throw e;
  }

  return { ok: true, organisation: inv.organisation, role: inv.role };
}
