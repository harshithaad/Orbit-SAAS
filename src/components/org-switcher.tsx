"use client";

import { useRouter } from "next/navigation";

type Org = { id: string; name: string; slug: string; role: string };

export function OrgSwitcher({ orgs, current }: { orgs: Org[]; current: string }) {
  const router = useRouter();
  return (
    <select
      className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
      value={current}
      onChange={(e) => {
        if (e.target.value === "__new") router.push("/onboarding");
        else router.push(`/app/${e.target.value}`);
      }}
    >
      {orgs.map((o) => (
        <option key={o.id} value={o.slug}>
          {o.name}
        </option>
      ))}
      <option value="__new">+ New organisation</option>
    </select>
  );
}
