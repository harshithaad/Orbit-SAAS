import { NextResponse } from "next/server";
import { processWebhook } from "@/lib/billing";

/**
 * Razorpay webhook endpoint.
 *
 * Always read the RAW body — the signature is over the exact bytes sent.
 * Returns 2xx for duplicates so Razorpay stops retrying them; returns 5xx on
 * unexpected errors so it retries (the transaction has rolled back).
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const outcome = await processWebhook({
    rawBody,
    signature: req.headers.get("x-razorpay-signature"),
    eventId: req.headers.get("x-razorpay-event-id"),
  });

  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  return NextResponse.json(
    { received: true, duplicate: outcome.duplicate, applied: outcome.applied, reason: outcome.reason },
    { status: 200 },
  );
}
