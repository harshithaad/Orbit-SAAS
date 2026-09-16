import { beforeEach, describe, expect, it } from "vitest";
import { TENANT_MODELS, TenantScopeError, assertScoped } from "@/lib/tenant";
import { createOrg, createUser, resetDb, tenantDb, testDb } from "./helpers";

describe("tenant guard (root client)", () => {
  beforeEach(resetDb);

  it("covers every model that has an organisationId column", async () => {
    // Introspect the live schema so a new tenant table can't slip past the guard.
    const rows = await testDb().$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'organisationId'`,
    );
    const tables = rows.map((r) => r.table_name).sort();
    expect(tables).toEqual([...TENANT_MODELS].sort());
  });

  it("refuses an unscoped findMany on a tenant model", async () => {
    await expect(testDb().project.findMany()).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("refuses an unscoped findUnique by id", async () => {
    await expect(
      testDb().project.findUnique({ where: { id: "anything" } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("refuses an unscoped create", async () => {
    await expect(
      // @ts-expect-error — deliberately omitting organisationId
      testDb().project.create({ data: { name: "no org" } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("refuses unscoped updateMany / deleteMany", async () => {
    await expect(
      testDb().project.updateMany({ where: {}, data: { name: "x" } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
    await expect(testDb().project.deleteMany({})).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("accepts a compound unique key that includes organisationId", () => {
    expect(() =>
      assertScoped("Membership", "findUnique", {
        where: { organisationId_userId: { organisationId: "o1", userId: "u1" } },
      }),
    ).not.toThrow();
  });

  it("ignores non-tenant models", async () => {
    await expect(testDb().user.findMany()).resolves.toEqual([]);
  });
});

describe("tenantDb(organisationId)", () => {
  beforeEach(resetDb);

  it("scopes reads so Org A never sees Org B's rows", async () => {
    const root = testDb();
    const a = await createOrg("a");
    const b = await createOrg("b");
    await root.project.create({ data: { organisationId: a.id, name: "A's project" } });
    await root.project.create({ data: { organisationId: b.id, name: "B's project" } });

    const dbA = tenantDb(a.id);
    const dbB = tenantDb(b.id);

    expect((await dbA.project.findMany()).map((p) => p.name)).toEqual(["A's project"]);
    expect((await dbB.project.findMany()).map((p) => p.name)).toEqual(["B's project"]);
    expect(await dbA.project.count()).toBe(1);
  });

  it("cannot read another org's row even by id", async () => {
    const root = testDb();
    const a = await createOrg("a");
    const b = await createOrg("b");
    const bProject = await root.project.create({
      data: { organisationId: b.id, name: "secret" },
    });

    const dbA = tenantDb(a.id);
    expect(await dbA.project.findUnique({ where: { id: bProject.id } })).toBeNull();
    expect(await dbA.project.findFirst({ where: { id: bProject.id } })).toBeNull();
  });

  it("overrides a caller-supplied organisationId on reads", async () => {
    const root = testDb();
    const a = await createOrg("a");
    const b = await createOrg("b");
    await root.project.create({ data: { organisationId: b.id, name: "B only" } });

    const dbA = tenantDb(a.id);
    // A malicious/buggy caller passes B's id — the scope still wins.
    const rows = await dbA.project.findMany({ where: { organisationId: b.id } });
    expect(rows).toEqual([]);
  });

  it("stamps creates with the bound organisationId", async () => {
    const root = testDb();
    const a = await createOrg("a");
    const b = await createOrg("b");
    const dbA = tenantDb(a.id);

    // Caller tries to write into B; it lands in A.
    const p = await dbA.project.create({
      data: { organisationId: b.id, name: "hijack attempt" },
    });
    expect(p.organisationId).toBe(a.id);
  });

  it("cannot update or delete another org's row", async () => {
    const root = testDb();
    const a = await createOrg("a");
    const b = await createOrg("b");
    const bProject = await root.project.create({
      data: { organisationId: b.id, name: "untouchable" },
    });
    const dbA = tenantDb(a.id);

    const upd = await dbA.project.updateMany({
      where: { id: bProject.id },
      data: { name: "pwned" },
    });
    expect(upd.count).toBe(0);

    const del = await dbA.project.deleteMany({ where: { id: bProject.id } });
    expect(del.count).toBe(0);

    const still = await root.project.findFirst({
      where: { id: bProject.id, organisationId: b.id },
    });
    expect(still?.name).toBe("untouchable");
  });

  it("scopes memberships (compound unique) correctly", async () => {
    const root = testDb();
    const a = await createOrg("a");
    const b = await createOrg("b");
    const u = await createUser();
    await root.membership.create({ data: { organisationId: a.id, userId: u.id, role: "OWNER" } });

    const dbB = tenantDb(b.id);
    expect(await dbB.membership.findMany({ where: { userId: u.id } })).toEqual([]);
  });
});
