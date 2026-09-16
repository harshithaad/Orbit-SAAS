import NextAuth, { type NextAuthConfig } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import GitHub from "next-auth/providers/github";
import Resend from "next-auth/providers/resend";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";

/**
 * Auth.js (NextAuth v5) configuration.
 *
 * Providers:
 *  - GitHub OAuth            (AUTH_GITHUB_ID / AUTH_GITHUB_SECRET)
 *  - Resend magic link       (RESEND_API_KEY) — only registered when the key is set
 *  - Dev login               local only: NODE_ENV !== "production" && DEV_LOGIN=true.
 *                            Signs in any email with no password so the app can be
 *                            exercised before OAuth/email keys exist. Never enabled
 *                            in production.
 *
 * Sessions are JWTs (required for the Credentials provider); the Prisma adapter
 * still persists users/accounts for OAuth and magic-link sign-ins. The adapter
 * only touches global tables (User, Account, Session, VerificationToken), so
 * the tenant guard on `db` is never tripped.
 */

const devLoginEnabled =
  process.env.NODE_ENV !== "production" && process.env.DEV_LOGIN === "true";

const providers: NextAuthConfig["providers"] = [GitHub];

if (process.env.RESEND_API_KEY) {
  providers.push(
    Resend({
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.EMAIL_FROM ?? "Orbit <onboarding@resend.dev>",
    }),
  );
}

if (devLoginEnabled) {
  providers.push(
    Credentials({
      id: "dev",
      name: "Dev login",
      credentials: { email: { label: "Email", type: "email" } },
      async authorize(creds) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        if (!email.includes("@")) return null;
        const user = await db.user.upsert({
          where: { email },
          update: {},
          create: { email, name: email.split("@")[0], emailVerified: new Date() },
        });
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  providers,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});

export { devLoginEnabled };
