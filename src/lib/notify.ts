import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { paymentFailedEmail, receiptEmail } from "@/lib/email-templates";
import { PLANS } from "@/config/plans";
import type { PlanTier } from "@/generated/prisma/enums";

/**
 * Billing notifications. Called AFTER the webhook transaction commits.
 * Recipients are the org's OWNERs (billing:manage). Every message carries an
 * idempotency key derived from the payment/event id so a redelivered webhook
 * that somehow got past dedup still can't double-send.
 */

function appUrl(path: string): string {
  return `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}${path}`;
}

async function billingRecipients(organisationId: string) {
  const org = await db.organisation.findUnique({
    where: { id: organisationId },
    select: {
      name: true,
      slug: true,
      memberships: { where: { organisationId, role: "OWNER" }, select: { user: { select: { email: true } } } },
    },
  });
  if (!org) return null;
  return { name: org.name, slug: org.slug, emails: org.memberships.map((m) => m.user.email) };
}

export async function notifyReceipt(p: {
  organisationId: string;
  tier: PlanTier;
  amountPaise: number;
  paymentId: string;
  periodEnd: Date | null;
}) {
  const org = await billingRecipients(p.organisationId);
  if (!org) return [];
  return Promise.all(
    org.emails.map((to) =>
      sendEmail(
        receiptEmail({
          to,
          orgName: org.name,
          planName: PLANS[p.tier].name,
          amountPaise: p.amountPaise,
          paymentId: p.paymentId,
          periodEnd: p.periodEnd,
          billingUrl: appUrl(`/app/${org.slug}/billing`),
        }),
      ),
    ),
  );
}

export async function notifyPaymentFailed(p: {
  organisationId: string;
  tier: PlanTier;
  amountPaise: number | null;
  reason: string | null;
  halted: boolean;
  eventId: string;
}) {
  const org = await billingRecipients(p.organisationId);
  if (!org) return [];
  return Promise.all(
    org.emails.map((to) =>
      sendEmail(
        paymentFailedEmail({
          to,
          orgName: org.name,
          planName: PLANS[p.tier].name,
          amountPaise: p.amountPaise,
          reason: p.reason,
          halted: p.halted,
          billingUrl: appUrl(`/app/${org.slug}/billing`),
          eventId: p.eventId,
        }),
      ),
    ),
  );
}
