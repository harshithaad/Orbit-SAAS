import { beforeEach, describe, expect, it } from "vitest";
import { changeMemberRole, removeMember } from "@/lib/members";
import { ForbiddenError } from "@/lib/errors";
import { createOrg, createUser, resetDb, tenantDb, testDb } from "./helpers";

describe("membership mutations", () => {
  beforeEach(resetDb);

  async function setup() {
    const org = await createOrg();
    const owner = await createUser("owner@acme.com");
    const admin = await createUser("admin@acme.com");
    const member = await createUser("member@acme.com");
    await testDb().membership.createMany({
      data: [
        { organisationId: org.id, userId: owner.id, role: "OWNER" },
        { organisationId: org.id, userId: admin.id, role: "ADMIN" },
        { organisationId: org.id, userId: member.id, role: "MEMBER" },
      ],
    });
    return { org, owner, admin, member, orgDb: tenantDb(org.id) };
  }

  it("owner promotes a member and it is audited", async () => {
    const { orgDb, owner, member } = await setup();
    const m = await changeMemberRole(orgDb, { id: owner.id, role: "OWNER" }, member.id, "ADMIN");
    expect(m.role).toBe("ADMIN");
    const log = await orgDb.auditLog.findFirst({ where: { action: "member.role_changed" } });
    expect(log?.metadata).toEqual({ from: "MEMBER", to: "ADMIN" });
  });

  it("admin cannot change roles", async () => {
    const { orgDb, admin, member } = await setup();
    await expect(
      changeMemberRole(orgDb, { id: admin.id, role: "ADMIN" }, member.id, "ADMIN"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the last owner cannot demote themselves or be removed", async () => {
    const { orgDb, owner } = await setup();
    await expect(
      changeMemberRole(orgDb, { id: owner.id, role: "OWNER" }, owner.id, "ADMIN"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeMember(orgDb, { id: owner.id, role: "OWNER" }, owner.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("admin removes a member but not the owner", async () => {
    const { orgDb, owner, admin, member } = await setup();
    await removeMember(orgDb, { id: admin.id, role: "ADMIN" }, member.id);
    expect(await orgDb.membership.count()).toBe(2);
    await expect(removeMember(orgDb, { id: admin.id, role: "ADMIN" }, owner.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("mutations are confined to the bound org", async () => {
    const { owner, member } = await setup();
    const other = await createOrg();
    // Acting through another org's client: the target is "not a member" there.
    await expect(
      changeMemberRole(tenantDb(other.id), { id: owner.id, role: "OWNER" }, member.id, "ADMIN"),
    ).rejects.toThrow("Not a member");
  });
});
