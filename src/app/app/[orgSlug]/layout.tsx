import Link from "next/link";
import { signOut } from "@/auth";
import { listUserOrgs, requireOrg } from "@/lib/org";
import { OrgSwitcher } from "@/components/org-switcher";

export default async function OrgLayout({ children, params }: LayoutProps<"/app/[orgSlug]">) {
  const { orgSlug } = await params;
  const ctx = await requireOrg(orgSlug);
  const orgs = await listUserOrgs(ctx.user.id);

  const nav = [
    { href: `/app/${orgSlug}`, label: "Overview" },
    { href: `/app/${orgSlug}/members`, label: "Members" },
    { href: `/app/${orgSlug}/billing`, label: "Billing" },
    { href: `/app/${orgSlug}/audit`, label: "Audit log" },
  ];

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <Link href="/app" className="text-lg font-semibold">
            🪐 Orbit
          </Link>
          <OrgSwitcher orgs={orgs} current={orgSlug} />
          <nav className="ml-4 flex gap-4 text-sm text-zinc-600">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="hover:text-zinc-900">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-zinc-500">
              {ctx.user.email} · <span className="font-medium text-zinc-700">{ctx.role.toLowerCase()}</span>
            </span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button className="text-zinc-500 hover:text-zinc-900">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 p-6">{children}</main>
    </div>
  );
}
