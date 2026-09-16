import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { tenantGuard, tenantScope } from "@/lib/tenant";

/**
 * Database clients.
 *
 *  - `db`               root client with the tenant guard installed. Any query
 *                       on a tenant-scoped model that is not constrained by
 *                       `organisationId` throws `TenantScopeError` before it
 *                       reaches Postgres. Use for global tables (User, Account,
 *                       WebhookEvent, Organisation) and explicitly-scoped
 *                       tenant queries in auth/webhook code.
 *
 *  - `tenantDb(orgId)`  the client application code should use. Injects
 *                       `organisationId` into every tenant-model query, so
 *                       callers can neither forget the scope nor supply another
 *                       org's id. `orgId` must come from a verified membership.
 */
function createBase(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

export function createClient(url?: string) {
  const base = createBase(url);
  return {
    db: base.$extends(tenantGuard),
    tenantDb: (organisationId: string) => base.$extends(tenantScope(organisationId)),
    disconnect: () => base.$disconnect(),
  };
}

export type Clients = ReturnType<typeof createClient>;
export type Db = Clients["db"];
export type TenantDb = ReturnType<Clients["tenantDb"]>;

const g = globalThis as unknown as { __orbitClients?: Clients };
const clients: Clients = g.__orbitClients ?? createClient();
if (process.env.NODE_ENV !== "production") g.__orbitClients = clients;

export const db: Db = clients.db;
export const tenantDb = clients.tenantDb;
