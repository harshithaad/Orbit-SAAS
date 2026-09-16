import { describe, expect, it } from "vitest";
import { ACTIONS, can, canChangeRole, canRemoveMember } from "@/lib/permissions";

describe("can(role, action)", () => {
  it("OWNER can do everything", () => {
    for (const a of ACTIONS) expect(can("OWNER", a)).toBe(true);
  });

  it("ADMIN can manage members and view billing but not manage billing or delete the org", () => {
    expect(can("ADMIN", "member:invite")).toBe(true);
    expect(can("ADMIN", "member:remove")).toBe(true);
    expect(can("ADMIN", "billing:view")).toBe(true);
    expect(can("ADMIN", "audit:read")).toBe(true);
    expect(can("ADMIN", "billing:manage")).toBe(false);
    expect(can("ADMIN", "member:change_role")).toBe(false);
    expect(can("ADMIN", "org:delete")).toBe(false);
  });

  it("MEMBER can only read and work on projects", () => {
    expect(can("MEMBER", "org:read")).toBe(true);
    expect(can("MEMBER", "project:create")).toBe(true);
    expect(can("MEMBER", "project:delete")).toBe(false);
    expect(can("MEMBER", "member:invite")).toBe(false);
    expect(can("MEMBER", "billing:view")).toBe(false);
    expect(can("MEMBER", "audit:read")).toBe(false);
  });
});

describe("canChangeRole", () => {
  const base = { actorRole: "OWNER" as const, actorIsTarget: false, ownerCount: 2 };

  it("owner can promote a member to admin or owner", () => {
    expect(canChangeRole({ ...base, targetRole: "MEMBER", newRole: "ADMIN" })).toBe(true);
    expect(canChangeRole({ ...base, targetRole: "MEMBER", newRole: "OWNER" })).toBe(true);
  });

  it("admin cannot change roles at all", () => {
    expect(canChangeRole({ ...base, actorRole: "ADMIN", targetRole: "MEMBER", newRole: "ADMIN" })).toBe(false);
  });

  it("nobody can change their own role", () => {
    expect(canChangeRole({ ...base, actorIsTarget: true, targetRole: "OWNER", newRole: "ADMIN" })).toBe(false);
  });

  it("the last owner cannot be demoted", () => {
    expect(canChangeRole({ ...base, ownerCount: 1, targetRole: "OWNER", newRole: "ADMIN" })).toBe(false);
    expect(canChangeRole({ ...base, ownerCount: 2, targetRole: "OWNER", newRole: "ADMIN" })).toBe(true);
  });
});

describe("canRemoveMember", () => {
  it("admin can remove members but not owners", () => {
    expect(canRemoveMember({ actorRole: "ADMIN", actorIsTarget: false, targetRole: "MEMBER", ownerCount: 1 })).toBe(true);
    expect(canRemoveMember({ actorRole: "ADMIN", actorIsTarget: false, targetRole: "OWNER", ownerCount: 2 })).toBe(false);
  });

  it("member cannot remove anyone else", () => {
    expect(canRemoveMember({ actorRole: "MEMBER", actorIsTarget: false, targetRole: "MEMBER", ownerCount: 1 })).toBe(false);
  });

  it("anyone can leave, except the last owner", () => {
    expect(canRemoveMember({ actorRole: "MEMBER", actorIsTarget: true, targetRole: "MEMBER", ownerCount: 1 })).toBe(true);
    expect(canRemoveMember({ actorRole: "OWNER", actorIsTarget: true, targetRole: "OWNER", ownerCount: 1 })).toBe(false);
    expect(canRemoveMember({ actorRole: "OWNER", actorIsTarget: true, targetRole: "OWNER", ownerCount: 2 })).toBe(true);
  });
});
