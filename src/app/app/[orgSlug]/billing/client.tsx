"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorText } from "@/components/ui";
import {
  cancelPlanAction,
  changePlanAction,
  confirmCheckoutAction,
  startCheckoutAction,
  syncPlanAction,
} from "./actions";

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open(): void; on(evt: string, cb: (r: unknown) => void): void };
  }
}

/** Loads checkout.razorpay.com once. */
function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load Razorpay Checkout"));
    document.body.appendChild(s);
  });
}

type Props = {
  orgSlug: string;
  tier: "FREE" | "PRO" | "TEAM";
  currentTier: "FREE" | "PRO" | "TEAM";
  hasGatewaySubscription: boolean;
  pendingTier: "FREE" | "PRO" | "TEAM" | null;
  canManage: boolean;
  configured: boolean;
  email: string;
};

export function PlanButton(p: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();

  if (!p.canManage) return null;

  const isCurrent = p.tier === p.currentTier && !p.pendingTier;
  const isPending = p.pendingTier === p.tier;
  const rank = { FREE: 0, PRO: 1, TEAM: 2 };
  const up = rank[p.tier] > rank[p.currentTier];

  if (isCurrent) return null;
  if (isPending) return <p className="mt-4 text-center text-xs text-amber-700">Switches to this plan at period end</p>;
  if (!p.configured) return <p className="mt-4 text-center text-xs text-zinc-400">Billing not configured</p>;

  const label = p.tier === "FREE" ? "Downgrade to Free" : up ? `Upgrade to ${p.tier[0]}${p.tier.slice(1).toLowerCase()}` : `Downgrade to ${p.tier[0]}${p.tier.slice(1).toLowerCase()}`;

  const run = () =>
    start(async () => {
      setError(undefined);
      // Existing paid subscription: change/cancel through the gateway.
      if (p.hasGatewaySubscription && p.currentTier !== "FREE") {
        const r = p.tier === "FREE" ? await cancelPlanAction(p.orgSlug) : await changePlanAction(p.orgSlug, p.tier);
        if (!r.ok) setError(r.error);
        else router.refresh();
        return;
      }
      // Free -> paid: Checkout.
      const s = await startCheckoutAction(p.orgSlug, p.tier);
      if (!s.ok) return setError(s.error);
      try {
        await loadCheckout();
      } catch (e) {
        return setError((e as Error).message);
      }
      const rzp = new window.Razorpay!({
        key: s.keyId,
        subscription_id: s.subscriptionId,
        name: s.name,
        description: s.description,
        prefill: { email: p.email },
        theme: { color: "#18181b" },
        handler: async (resp: { razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string }) => {
          const c = await confirmCheckoutAction(p.orgSlug, {
            paymentId: resp.razorpay_payment_id,
            subscriptionId: resp.razorpay_subscription_id,
            signature: resp.razorpay_signature,
          });
          if (!c.ok) setError(c.error);
          router.refresh();
        },
      });
      rzp.on("payment.failed", () => setError("Payment failed. You can try again."));
      rzp.open();
    });

  return (
    <div className="mt-4">
      <Button variant={up ? "primary" : "secondary"} className="w-full" disabled={pending} onClick={run}>
        {pending ? "Working…" : label}
      </Button>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

export function SyncButton({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      className="text-sm text-zinc-500 underline hover:text-zinc-900 disabled:opacity-50"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await syncPlanAction(orgSlug);
          router.refresh();
        })
      }
    >
      {pending ? "Refreshing…" : "Refresh from Razorpay"}
    </button>
  );
}
