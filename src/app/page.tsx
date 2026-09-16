import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/org";

export default async function Home() {
  if (await getUser()) redirect("/app");
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="text-5xl">🪐</div>
      <h1 className="text-3xl font-semibold tracking-tight">Orbit</h1>
      <p className="max-w-md text-zinc-600">
        Organisations, roles, subscriptions and usage limits — a multi-tenant SaaS starter.
      </p>
      <Link
        href="/login"
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
      >
        Sign in
      </Link>
    </main>
  );
}
