import { Prisma } from "@/generated/prisma/client";

/**
 * Tenant isolation.
 *
 * Two layers:
 *
 *  1. `tenantGuard` — a Prisma client extension installed on the root client.
 *     It inspects every query against a tenant-scoped model and throws
 *     `TenantScopeError` if the query is not constrained by `organisationId`.
 *     This is the safety net: it makes an unscoped query impossible, not just
 *     unlikely.
 *
 *  2. `tenantDb(organisationId)` — the client application code should use.
 *     It returns a Prisma client that *injects* `organisationId` into every
 *     where/data clause for tenant models, so callers cannot forget it and
 *     cannot supply a different org's id.
 *
 * `organisationId` must always come from the caller's verified membership
 * (see auth/org resolution), never from request input.
 */

/** Models that hold tenant data. Every one has an `organisationId` column. */
export const TENANT_MODELS = new Set<Prisma.ModelName>([
  "Membership",
  "Invitation",
  "Subscription",
  "UsageRecord",
  "AuditLog",
  "Project",
]);

export class TenantScopeError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Refusing ${operation} on tenant model ${model} without an organisationId scope`,
    );
    this.name = "TenantScopeError";
  }
}

type AnyArgs = Record<string, unknown> & {
  where?: Record<string, unknown>;
  data?: unknown;
  create?: Record<string, unknown>;
};

/** True if a where clause pins the query to exactly one organisation. */
function whereIsScoped(where: Record<string, unknown> | undefined): boolean {
  if (!where) return false;
  const direct = where.organisationId;
  if (typeof direct === "string" && direct.length > 0) return true;
  // Compound unique keys: { organisationId_userId: { organisationId, userId } }
  return Object.values(where).some(
    (v) =>
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof (v as Record<string, unknown>).organisationId === "string",
  );
}

function dataIsScoped(data: unknown): boolean {
  if (Array.isArray(data)) return data.every(dataIsScoped);
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.organisationId === "string") return true;
    // Nested relation connect: { organisation: { connect: { id } } }
    const rel = d.organisation as Record<string, unknown> | undefined;
    if (rel && typeof rel === "object" && "connect" in rel) return true;
  }
  return false;
}

const READ_OPS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);
const WRITE_WHERE_OPS = new Set(["update", "updateMany", "delete", "deleteMany"]);
const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);

export function assertScoped(
  model: string,
  operation: string,
  args: AnyArgs | undefined,
): void {
  if (!TENANT_MODELS.has(model as Prisma.ModelName)) return;
  const a = args ?? {};

  if (READ_OPS.has(operation) || WRITE_WHERE_OPS.has(operation)) {
    if (!whereIsScoped(a.where)) throw new TenantScopeError(model, operation);
    return;
  }
  if (CREATE_OPS.has(operation)) {
    if (!dataIsScoped(a.data)) throw new TenantScopeError(model, operation);
    return;
  }
  if (operation === "upsert") {
    if (!whereIsScoped(a.where) || !dataIsScoped(a.create)) {
      throw new TenantScopeError(model, operation);
    }
    return;
  }
  // Anything else (e.g. $queryRaw is not a model op) — be strict.
  throw new TenantScopeError(model, operation);
}

export const tenantGuard = Prisma.defineExtension({
  name: "tenantGuard",
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        assertScoped(model, operation, args as AnyArgs);
        return query(args);
      },
    },
  },
});

/**
 * Extension that binds a client to one organisation. Every tenant-model query
 * gets `organisationId` merged into `where` (and `data` for creates),
 * overriding anything the caller passed, and is then re-checked by
 * `assertScoped` as a belt-and-braces guarantee.
 */
export function tenantScope(organisationId: string) {
  if (!organisationId) throw new Error("tenantScope requires an organisationId");

  return Prisma.defineExtension({
    name: `tenant:${organisationId}`,
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model as Prisma.ModelName)) return query(args);
          const a = { ...(args as AnyArgs) };

          if (READ_OPS.has(operation) || WRITE_WHERE_OPS.has(operation)) {
            a.where = { ...(a.where ?? {}), organisationId };
          } else if (CREATE_OPS.has(operation)) {
            a.data = Array.isArray(a.data)
              ? a.data.map((d) => ({ ...(d as object), organisationId }))
              : { ...(a.data as object), organisationId };
          } else if (operation === "upsert") {
            a.where = { ...(a.where ?? {}), organisationId };
            a.create = { ...(a.create ?? {}), organisationId };
          }
          assertScoped(model, operation, a);
          return query(a as typeof args);
        },
      },
    },
  });
}
