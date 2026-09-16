import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

/**
 * Edge-side gate: anything under /app or /onboarding requires a session.
 * This is a convenience redirect only — real authorisation happens in
 * `requireUser` / `requireOrg` (src/lib/org.ts) on every server call.
 */
export async function proxy(req: NextRequest) {
  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
    secureCookie: process.env.NODE_ENV === "production",
  });
  if (token) return NextResponse.next();

  const login = new URL("/login", req.url);
  login.searchParams.set("callbackUrl", req.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/app/:path*", "/onboarding"],
};
