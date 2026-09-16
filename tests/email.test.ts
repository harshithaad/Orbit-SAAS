import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setEmailTransport, type EmailMessage } from "@/lib/email";
import { inviteEmail, paymentFailedEmail, receiptEmail } from "@/lib/email-templates";
import { createInvitation } from "@/lib/invites";
import { processWebhook, type RzpWebhookEvent } from "@/lib/billing";
import { signWebhookBody } from "@/lib/razorpay";
import { createOrg, createUser, resetDb, tenantDb, testDb } from "./helpers";

const PRO = process.env.RAZORPAY_PLAN_PRO!;

let sent: EmailMessage[] = [];
let restore = () => {};
beforeEach(async () => {
  await resetDb();
  sent = [];
  restore = setEmailTransport({ name: "capture", send: async (m) => (sent.push(m), { id: `msg_${sent.length}` }) });
});
afterEach(() => restore());

describe("templates", () => {
  it("invite email contains the link, role and expiry, and is keyed by invitation id", () => {
    const m = inviteEmail({
      to: "bob@acme.com",
      orgName: "Acme",
      inviterName: "Alice",
      role: "ADMIN",
      url: "http://localhost:3000/invite/abc.def",
      expiresAt: new Date("2026-09-23T00:00:00Z"),
      invitationId: "inv1",
    });
    expect(m.subject).toBe("Alice invited you to join Acme on Orbit");
    expect(m.html).toContain("http://localhost:3000/invite/abc.def");
    expect(m.text).toContain("http://localhost:3000/invite/abc.def");
    expect(m.html).toContain("admin");
    expect(m.idempotencyKey).toBe("invite/inv1");
  });

  it("receipt formats INR and is keyed by payment id", () => {
    const m = receiptEmail({
      to: "a@b.com",
      orgName: "Acme",
      planName: "Pro",
      amountPaise: 74900,
      paymentId: "pay_1",
      periodEnd: null,
      billingUrl: "http://x/billing",
    });
    expect(m.subject).toContain("₹749.00");
    expect(m.idempotencyKey).toBe("receipt/pay_1");
  });

  it("payment-failed email distinguishes retrying from halted", () => {
    const base = { to: "a@b.com", orgName: "Acme", planName: "Pro", amountPaise: 74900, reason: "Card declined", billingUrl: "http://x", eventId: "evt" };
    expect(paymentFailedEmail({ ...base, halted: false }).text).toContain("retry automatically");
    expect(paymentFailedEmail({ ...base, halted: true }).text).toContain("Free plan");
    expect(paymentFailedEmail({ ...base, halted: true }).subject).toMatch(/^Action required/);
  });
});

describe("invite flow sends email", () => {
  it("sends one invite email to the invitee with the working link", async () => {
    const org = await createOrg("Acme");
    const owner = await createUser("alice@acme.com");
    await testDb().membership.create({ data: { organisationId: org.id, userId: owner.id, role: "OWNER" } });

    const { url, invitation } = await createInvitation(tenantDb(org.id), {
      email: "bob@acme.com",
      role: "MEMBER",
      invitedById: owner.id,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("bob@acme.com");
    expect(sent[0].html).toContain(url);
    expect(sent[0].idempotencyKey).toBe(`invite/${invitation.id}`);
    expect(sent[0].subject).toContain("Acme");
  });
});

describe("billing notifications", () => {
  async function paidOrg() {
    const org = await createOrg("Acme");
    const owner = await createUser("owner@acme.com");
    const member = await createUser("member@acme.com");
    await testDb().membership.createMany({
      data: [
        { organisationId: org.id, userId: owner.id, role: "OWNER" },
        { organisationId: org.id, userId: member.id, role: "MEMBER" },
      ],
    });
    await testDb().subscription.create({ data: { organisationId: org.id, tier: "PRO", status: "ACTIVE", gatewaySubscriptionId: "sub_1" } });
    return org;
  }

  function event(orgId: string, type: string, status: string, extra: Partial<RzpWebhookEvent["payload"]> = {}, at = 1_900_000_000) {
    const e: RzpWebhookEvent = {
      entity: "event",
      event: type,
      created_at: at,
      payload: {
        subscription: { entity: { id: "sub_1", plan_id: PRO, status: status as never, current_end: at + 30 * 86400, notes: { organisationId: orgId } } },
        ...extra,
      },
    };
    const body = JSON.stringify(e);
    return { body, signature: signWebhookBody(body) };
  }

  it("subscription.charged emails a receipt to owners only, once", async () => {
    const org = await paidOrg();
    const ev = event(org.id, "subscription.charged", "active", { payment: { entity: { id: "pay_9", amount: 74900, currency: "INR" } } });

    await processWebhook({ rawBody: ev.body, signature: ev.signature, eventId: "evt_r1" });
    await processWebhook({ rawBody: ev.body, signature: ev.signature, eventId: "evt_r1" }); // retry

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@acme.com");
    expect(sent[0].subject).toContain("Receipt");
    expect(sent[0].idempotencyKey).toBe("receipt/pay_9");
  });

  it("subscription.halted emails a payment-failed notice marked as halted", async () => {
    const org = await paidOrg();
    const ev = event(org.id, "subscription.halted", "halted", {
      payment: { entity: { id: "pay_f", amount: 74900, currency: "INR", error_description: "Card declined" } },
    });
    await processWebhook({ rawBody: ev.body, signature: ev.signature, eventId: "evt_h1" });

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^Action required/);
    expect(sent[0].text).toContain("Card declined");
    expect(sent[0].idempotencyKey).toBe("payment-failed/evt_h1");
  });

  it("an out-of-order (ignored) event sends nothing", async () => {
    const org = await paidOrg();
    const newer = event(org.id, "subscription.cancelled", "cancelled", {}, 2_000_000_000);
    const older = event(org.id, "subscription.charged", "active", { payment: { entity: { id: "pay_old", amount: 1, currency: "INR" } } }, 1_900_000_000);
    await processWebhook({ rawBody: newer.body, signature: newer.signature, eventId: "evt_n" });
    await processWebhook({ rawBody: older.body, signature: older.signature, eventId: "evt_o" });
    expect(sent).toHaveLength(0);
  });
});
