import { beforeEach, describe, expect, it } from "vitest";
import {
  INVITE_TTL_DAYS,
  acceptInvitation,
  buildInviteToken,
  createInvitation,
  previewInvitation,
  revokeInvitation,
  verifyInviteToken,
} from "@/lib/invites";
import { createOrg, createUser, resetDb, tenantDb, testDb } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

describe("invite tokens", () => {
  const payload = { id: "inv1", org: "org1", email: "a@b.com", exp: Date.now() + DAY, nonce: "n" };

  it("round-trips a signed token", () => {
    const t = buildInviteToken(payload);
    const v = verifyInviteToken(t);
    expect(v.ok && v.payload).toEqual(payload);
  });

  it("rejects a tampered payload", () => {
    const t = buildInviteToken(payload);
    const [p, sig] = t.split(".");
    const evil = Buffer.from(JSON.stringify({ ...payload, email: "evil@b.com" })).toString("base64url");
    expect(verifyInviteToken(`${evil}.${sig}`)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyInviteToken(`${p}.${sig.slice(0, -2)}xx`)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an expired token", () => {
    const t = buildInviteToken({ ...payload, exp: Date.now() - 1 });
    expect(verifyInviteToken(t)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects garbage", () => {
    expect(verifyInviteToken("nope")).toEqual({ ok: false, reason: "malformed" });
    expect(verifyInviteToken("")).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("invitation flow", () => {
  beforeEach(resetDb);

  async function setup() {
    const org = await createOrg();
    const owner = await createUser("owner@acme.com");
    await testDb().membership.create({ data: { organisationId: org.id, userId: owner.id, role: "OWNER" } });
    return { org, owner, orgDb: tenantDb(org.id) };
  }

  it("creates a pending invite with a 7-day expiry and an audit entry", async () => {
    const { orgDb, owner } = await setup();
    const { invitation, url } = await createInvitation(orgDb, {
      email: "Bob@Acme.com",
      role: "MEMBER",
      invitedById: owner.id,
    });
    expect(invitation.email).toBe("bob@acme.com");
    expect(invitation.status).toBe("PENDING");
    expect(invitation.expiresAt.getTime() - Date.now()).toBeGreaterThan((INVITE_TTL_DAYS - 1) * DAY);
    expect(url).toMatch(/\/invite\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(invitation.tokenHash).not.toContain(url.split("/invite/")[1]);

    const log = await orgDb.auditLog.findMany();
    expect(log.map((l) => l.action)).toEqual(["member.invited"]);
  });

  it("re-inviting the same email revokes the previous link", async () => {
    const { orgDb, owner } = await setup();
    const first = await createInvitation(orgDb, { email: "bob@acme.com", role: "MEMBER", invitedById: owner.id });
    const second = await createInvitation(orgDb, { email: "bob@acme.com", role: "ADMIN", invitedById: owner.id });

    expect((await previewInvitation(first.token)).ok).toBe(false);
    expect((await previewInvitation(second.token)).ok).toBe(true);
  });

  it("accepting creates the membership with the invited role and marks the invite used", async () => {
    const { org, orgDb, owner } = await setup();
    const { token } = await createInvitation(orgDb, { email: "bob@acme.com", role: "ADMIN", invitedById: owner.id });
    const bob = await createUser("bob@acme.com");

    const r = await acceptInvitation(token, bob);
    expect(r.ok && r.role).toBe("ADMIN");
    expect(r.ok && r.organisation.id).toBe(org.id);

    const m = await orgDb.membership.findFirst({ where: { userId: bob.id } });
    expect(m?.role).toBe("ADMIN");

    // Second use is rejected.
    expect(await acceptInvitation(token, bob)).toEqual({ ok: false, reason: "not_pending" });
    expect((await orgDb.auditLog.findMany()).map((l) => l.action).sort()).toEqual([
      "member.invited",
      "member.joined",
    ]);
  });

  it("rejects acceptance by a different email", async () => {
    const { orgDb, owner } = await setup();
    const { token } = await createInvitation(orgDb, { email: "bob@acme.com", role: "MEMBER", invitedById: owner.id });
    const mallory = await createUser("mallory@evil.com");
    expect(await acceptInvitation(token, mallory)).toEqual({ ok: false, reason: "email_mismatch" });
    expect(await orgDb.membership.count()).toBe(1);
  });

  it("rejects a revoked invitation", async () => {
    const { orgDb, owner } = await setup();
    const { invitation, token } = await createInvitation(orgDb, {
      email: "bob@acme.com",
      role: "MEMBER",
      invitedById: owner.id,
    });
    expect(await revokeInvitation(orgDb, invitation.id, owner.id)).toBe(true);
    expect(await revokeInvitation(orgDb, invitation.id, owner.id)).toBe(false);
    const bob = await createUser("bob@acme.com");
    expect(await acceptInvitation(token, bob)).toEqual({ ok: false, reason: "not_pending" });
  });

  it("a token whose signed org differs from the row's org is not found", async () => {
    const { orgDb, owner } = await setup();
    const other = await createOrg();
    const { invitation } = await createInvitation(orgDb, { email: "bob@acme.com", role: "MEMBER", invitedById: owner.id });
    // Forge a validly-signed token pointing at another org — the row lookup is scoped by org.
    const forged = buildInviteToken({
      id: invitation.id,
      org: other.id,
      email: "bob@acme.com",
      exp: Date.now() + DAY,
      nonce: "x",
    });
    expect(await previewInvitation(forged)).toEqual({ ok: false, reason: "not_found" });
  });

  it("an admin in another org cannot revoke this org's invite", async () => {
    const { orgDb, owner } = await setup();
    const other = await createOrg();
    const { invitation } = await createInvitation(orgDb, { email: "bob@acme.com", role: "MEMBER", invitedById: owner.id });
    expect(await revokeInvitation(tenantDb(other.id), invitation.id, owner.id)).toBe(false);
    expect((await previewInvitation((await createInvitation(orgDb, { email: "c@acme.com", role: "MEMBER", invitedById: owner.id })).token)).ok).toBe(true);
  });
});
