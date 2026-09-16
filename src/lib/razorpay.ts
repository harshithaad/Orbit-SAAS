import { createHmac, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";
import type { PlanTier } from "@/generated/prisma/enums";
import { PLANS, TIER_ORDER } from "@/config/plans";

/**
 * Razorpay SDK wrapper + the two signature checks.
 *
 *  - Webhooks:  X-Razorpay-Signature = HMAC-SHA256(webhook_secret, raw body)
 *  - Checkout:  razorpay_signature   = HMAC-SHA256(key_secret, payment_id|subscription_id)
 *
 * Both compare with timingSafeEqual. Everything here is a thin, pure layer so
 * the billing state machine (billing.ts) can be tested without the network.
 */

let client: Razorpay | undefined;

export function razorpay(): Razorpay {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set");
  client ??= new Razorpay({ key_id, key_secret });
  return client;
}

export function isRazorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Verifies a webhook delivery against the raw request body. */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  return safeEqualHex(hmacHex(secret, rawBody), signature);
}

/** Used by tests and the replay script to produce valid deliveries. */
export function signWebhookBody(rawBody: string, secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? ""): string {
  return hmacHex(secret, rawBody);
}

/** Verifies the signature Checkout returns after a successful subscription payment. */
export function verifyCheckoutSignature(opts: {
  paymentId: string;
  subscriptionId: string;
  signature: string;
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;
  return safeEqualHex(hmacHex(secret, `${opts.paymentId}|${opts.subscriptionId}`), opts.signature);
}

/** Razorpay Plan id for a paid tier, from env. */
export function planIdFor(tier: PlanTier): string {
  const env = PLANS[tier].razorpayPlanEnv;
  if (!env) throw new Error(`${tier} has no Razorpay plan`);
  const id = process.env[env];
  if (!id) throw new Error(`${env} is not set`);
  return id;
}

/** Reverse lookup; unknown plan ids map to null so a stray event can't grant a tier. */
export function tierForPlanId(planId: string | null | undefined): PlanTier | null {
  if (!planId) return null;
  for (const t of TIER_ORDER) {
    const env = PLANS[t].razorpayPlanEnv;
    if (env && process.env[env] === planId) return t;
  }
  return null;
}
