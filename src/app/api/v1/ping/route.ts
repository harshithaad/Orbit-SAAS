import { NextResponse } from "next/server";
import { getOrgContext } from "@/lib/org";
import { UsageLimitError, consumeNow } from "@/lib/usage";

/**
 * Example metered endpoint. Every call consumes one `api_calls` unit for the
 * org; the plan's hard limit returns 429 with the quota in the body.
 *
 * Auth is the session cookie (same as the app); `?org=<slug>` selects the org
 * and membership is verified by getOrgContext.
 */
export async function POST(req: Request) {
  const slug = new URL(req.url).searchParams.get("org") ?? "";
  const ctx = await getOrgContext(slug);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const u = await consumeNow(ctx.db, "api_calls");
    return NextResponse.json(
      { ok: true, used: u.used, hard: u.hard, level: u.level },
      { headers: { "x-ratelimit-limit": String(u.hard ?? ""), "x-ratelimit-remaining": String(u.hard === null ? "" : u.hard - u.used) } },
    );
  } catch (e) {
    if (e instanceof UsageLimitError) {
      return NextResponse.json(
        { error: `API call limit of ${e.limit} reached on the ${e.tier} plan`, used: e.limit, hard: e.limit },
        { status: 429 },
      );
    }
    throw e;
  }
}
