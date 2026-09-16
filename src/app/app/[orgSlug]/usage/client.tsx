"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

export function PingButton({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [last, setLast] = useState<string>();

  const call = (n: number) =>
    start(async () => {
      let msg = "";
      for (let i = 0; i < n; i++) {
        const res = await fetch(`/api/v1/ping?org=${encodeURIComponent(orgSlug)}`, { method: "POST" });
        const j = await res.json();
        msg = res.ok ? `${res.status} — ${j.used}/${j.hard ?? "∞"} used` : `${res.status} — ${j.error}`;
        if (!res.ok) break;
      }
      setLast(msg);
      router.refresh();
    });

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button variant="secondary" disabled={pending} onClick={() => call(1)}>
          Call once
        </Button>
        <Button variant="secondary" disabled={pending} onClick={() => call(25)}>
          Call ×25
        </Button>
      </div>
      {last && <p className="font-mono text-xs text-zinc-600">{last}</p>}
    </div>
  );
}
