import type { EmailMessage } from "@/lib/email";

/**
 * Email templates as plain functions returning {subject, html, text}.
 * Kept dependency-free so they render identically in tests and production.
 */

const APP = "Orbit";

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html><body style="margin:0;background:#fafafa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid #e4e4e7;border-radius:8px">
      <tr><td style="padding:24px 28px 8px;font-size:18px;font-weight:600">🪐 ${APP}</td></tr>
      <tr><td style="padding:0 28px 8px;font-size:20px;font-weight:600">${title}</td></tr>
      <tr><td style="padding:0 28px 24px;font-size:15px;line-height:1.5;color:#3f3f46">${bodyHtml}</td></tr>
    </table>
    <p style="font-size:12px;color:#a1a1aa;margin-top:16px">You're receiving this because of activity in your ${APP} organisation.</p>
  </td></tr></table>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:20px 0"><a href="${href}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:500">${label}</a></p>`;
}

function inr(amountPaise: number): string {
  return `₹${(amountPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

export function inviteEmail(p: {
  to: string;
  orgName: string;
  inviterName: string;
  role: string;
  url: string;
  expiresAt: Date;
  invitationId: string;
}): EmailMessage {
  const subject = `${p.inviterName} invited you to join ${p.orgName} on ${APP}`;
  const expires = p.expiresAt.toUTCString();
  return {
    to: p.to,
    subject,
    idempotencyKey: `invite/${p.invitationId}`,
    tags: { type: "invite" },
    html: layout(
      `Join ${p.orgName}`,
      `<p><b>${p.inviterName}</b> has invited you to join <b>${p.orgName}</b> as a <b>${p.role.toLowerCase()}</b>.</p>
       ${button(p.url, "Accept invitation")}
       <p style="font-size:13px;color:#71717a">This link is personal to ${p.to} and expires ${expires}.<br>If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all">${p.url}</span></p>`,
    ),
    text: `${p.inviterName} has invited you to join ${p.orgName} on ${APP} as a ${p.role.toLowerCase()}.

Accept: ${p.url}

This link is for ${p.to} and expires ${expires}.`,
  };
}

export function receiptEmail(p: {
  to: string;
  orgName: string;
  planName: string;
  amountPaise: number;
  paymentId: string;
  periodEnd: Date | null;
  billingUrl: string;
}): EmailMessage {
  const amount = inr(p.amountPaise);
  const renews = p.periodEnd ? p.periodEnd.toDateString() : "next cycle";
  return {
    to: p.to,
    subject: `Receipt: ${amount} for ${p.orgName} (${p.planName})`,
    idempotencyKey: `receipt/${p.paymentId}`,
    tags: { type: "receipt" },
    html: layout(
      "Payment received",
      `<p>Thanks — we've received <b>${amount}</b> for the <b>${p.planName}</b> plan on <b>${p.orgName}</b>.</p>
       <table style="font-size:14px;margin:12px 0;border-collapse:collapse">
         <tr><td style="padding:4px 12px 4px 0;color:#71717a">Payment ID</td><td>${p.paymentId}</td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#71717a">Amount</td><td>${amount}</td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#71717a">Next renewal</td><td>${renews}</td></tr>
       </table>
       ${button(p.billingUrl, "Manage billing")}`,
    ),
    text: `Payment received: ${amount} for the ${p.planName} plan on ${p.orgName}.
Payment ID: ${p.paymentId}
Next renewal: ${renews}

Manage billing: ${p.billingUrl}`,
  };
}

export function paymentFailedEmail(p: {
  to: string;
  orgName: string;
  planName: string;
  amountPaise: number | null;
  reason: string | null;
  halted: boolean;
  billingUrl: string;
  eventId: string;
}): EmailMessage {
  const amount = p.amountPaise ? inr(p.amountPaise) : "your subscription payment";
  const consequence = p.halted
    ? `Your subscription has been paused and <b>${p.orgName}</b> is now on the Free plan. Your data is safe; paid features are locked until payment succeeds.`
    : `We'll retry automatically over the next few days. Until then your <b>${p.planName}</b> features stay active.`;
  return {
    to: p.to,
    subject: `${p.halted ? "Action required" : "Payment failed"}: ${p.orgName} (${p.planName})`,
    idempotencyKey: `payment-failed/${p.eventId}`,
    tags: { type: "payment_failed" },
    html: layout(
      p.halted ? "Subscription paused" : "Payment failed",
      `<p>We couldn't collect ${amount} for the <b>${p.planName}</b> plan on <b>${p.orgName}</b>.${p.reason ? ` Reason: <i>${p.reason}</i>.` : ""}</p>
       <p>${consequence}</p>
       ${button(p.billingUrl, "Update payment method")}`,
    ),
    text: `We couldn't collect ${amount} for the ${p.planName} plan on ${p.orgName}.${p.reason ? ` Reason: ${p.reason}.` : ""}

${p.halted ? `Your subscription has been paused and ${p.orgName} is now on the Free plan.` : `We'll retry automatically. Your ${p.planName} features stay active for now.`}

Update payment method: ${p.billingUrl}`,
  };
}
