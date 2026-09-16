import type { PlanTier } from "@/generated/prisma/enums";

/**
 * THE single source of truth for what each tier unlocks.
 *
 * Everything plan-related reads from here: feature gates, usage limits, the
 * billing page, and the Stripe price mapping. Nothing else hard-codes a tier.
 */

/** Metered resources. Limits are per organisation; `null` = unlimited. */
export const METRICS = ["members", "projects", "api_calls"] as const;
export type Metric = (typeof METRICS)[number];

/** Boolean capabilities gated by tier. */
export const FEATURES = [
  "audit_log",          // view the audit log
  "audit_export",       // download audit log as CSV
  "api_access",         // issue API keys
  "custom_roles",       // beyond owner/admin/member (placeholder gate)
  "priority_support",
  "sso",
  "advanced_analytics",
] as const;
export type Feature = (typeof FEATURES)[number];

export type MetricLimit = {
  /** Hard cap: the action is blocked at this count. `null` = unlimited. */
  hard: number | null;
  /** Soft cap: the user is warned at this count (must be <= hard). */
  soft: number | null;
  /** Whether the counter resets each billing month. */
  period: "monthly" | "lifetime";
};

export type PlanDefinition = {
  tier: PlanTier;
  name: string;
  description: string;
  /** Display price in USD per month; 0 for Free. */
  priceMonthlyUsd: number;
  /** Env var holding the Stripe Price id (test mode). Free has none. */
  stripePriceEnv: "STRIPE_PRICE_PRO" | "STRIPE_PRICE_TEAM" | null;
  limits: Record<Metric, MetricLimit>;
  features: Record<Feature, boolean>;
};

export const PLANS: Record<PlanTier, PlanDefinition> = {
  FREE: {
    tier: "FREE",
    name: "Free",
    description: "For trying things out.",
    priceMonthlyUsd: 0,
    stripePriceEnv: null,
    limits: {
      members: { hard: 3, soft: 2, period: "lifetime" },
      projects: { hard: 3, soft: 2, period: "lifetime" },
      api_calls: { hard: 100, soft: 80, period: "monthly" },
    },
    features: {
      audit_log: false,
      audit_export: false,
      api_access: false,
      custom_roles: false,
      priority_support: false,
      sso: false,
      advanced_analytics: false,
    },
  },
  PRO: {
    tier: "PRO",
    name: "Pro",
    description: "For small teams shipping real work.",
    priceMonthlyUsd: 9,
    stripePriceEnv: "STRIPE_PRICE_PRO",
    limits: {
      members: { hard: 10, soft: 8, period: "lifetime" },
      projects: { hard: 25, soft: 20, period: "lifetime" },
      api_calls: { hard: 2_000, soft: 1_600, period: "monthly" },
    },
    features: {
      audit_log: true,
      audit_export: false,
      api_access: true,
      custom_roles: false,
      priority_support: false,
      sso: false,
      advanced_analytics: true,
    },
  },
  TEAM: {
    tier: "TEAM",
    name: "Team",
    description: "For growing organisations.",
    priceMonthlyUsd: 29,
    stripePriceEnv: "STRIPE_PRICE_TEAM",
    limits: {
      members: { hard: null, soft: null, period: "lifetime" },
      projects: { hard: null, soft: null, period: "lifetime" },
      api_calls: { hard: 20_000, soft: 16_000, period: "monthly" },
    },
    features: {
      audit_log: true,
      audit_export: true,
      api_access: true,
      custom_roles: true,
      priority_support: true,
      sso: true,
      advanced_analytics: true,
    },
  },
};

export const TIER_ORDER: PlanTier[] = ["FREE", "PRO", "TEAM"];

export const FEATURE_LABELS: Record<Feature, string> = {
  audit_log: "Audit log",
  audit_export: "Audit log export",
  api_access: "API access",
  custom_roles: "Custom roles",
  priority_support: "Priority support",
  sso: "Single sign-on",
  advanced_analytics: "Advanced analytics",
};

export const METRIC_LABELS: Record<Metric, string> = {
  members: "Members",
  projects: "Projects",
  api_calls: "API calls / month",
};
