import { METRIC_LABELS } from "@/config/plans";
import type { UsageStatus } from "@/lib/usage";

const COLORS: Record<UsageStatus["level"], string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  blocked: "bg-red-500",
};

export function UsageBars({ metrics }: { metrics: UsageStatus[] }) {
  return (
    <ul className="space-y-4">
      {metrics.map((m) => (
        <li key={m.metric}>
          <div className="mb-1 flex items-baseline justify-between text-sm">
            <span className="font-medium">{METRIC_LABELS[m.metric]}</span>
            <span className="text-zinc-600">
              {m.used.toLocaleString()}
              {m.hard === null ? " · unlimited" : ` / ${m.hard.toLocaleString()}`}
              {m.level === "warning" && <span className="ml-2 text-amber-700">approaching limit</span>}
              {m.level === "blocked" && <span className="ml-2 text-red-700">limit reached</span>}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className={`h-full rounded-full ${COLORS[m.level]}`}
              style={{ width: `${Math.round((m.fraction ?? 0) * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {m.period === "monthly"
              ? `Resets ${new Date(Date.UTC(m.periodStart.getUTCFullYear(), m.periodStart.getUTCMonth() + 1, 1)).toLocaleDateString()}`
              : "Lifetime — frees up when items are removed"}
            {m.soft !== null && m.hard !== null && ` · warning at ${m.soft}`}
          </p>
        </li>
      ))}
    </ul>
  );
}
