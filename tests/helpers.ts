import { createClient, type Clients } from "@/lib/db";

let _clients: Clients | undefined;

/** Shared clients for tests (point at TEST_DATABASE_URL via setup.ts). */
export function clients(): Clients {
  _clients ??= createClient(process.env.DATABASE_URL);
  return _clients;
}
export const testDb = () => clients().db;
export const tenantDb = (orgId: string) => clients().tenantDb(orgId);

/** Wipe every table. */
export async function resetDb() {
  await testDb().$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog", "UsageRecord", "Project", "Invitation", "Membership",
      "Subscription", "WebhookEvent", "Organisation",
      "Session", "Account", "VerificationToken", "User"
    RESTART IDENTITY CASCADE
  `);
}

let seq = 0;
export function uniq(prefix = "x") {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export async function createUser(email = `${uniq("user")}@example.com`) {
  return testDb().user.create({ data: { email, name: email.split("@")[0] } });
}

export async function createOrg(name = uniq("org")) {
  return testDb().organisation.create({
    data: { name, slug: name.toLowerCase() },
  });
}
