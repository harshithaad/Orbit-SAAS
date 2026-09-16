import { Resend } from "resend";

/**
 * Transactional email.
 *
 * `sendEmail` picks a transport:
 *   - Resend when RESEND_API_KEY is set,
 *   - otherwise a console transport that logs the message (dev),
 *   - and in tests, `setEmailTransport()` swaps in a capturing transport so
 *     tests can assert on what would have been sent.
 *
 * Sends are fire-and-forget from business logic (`void sendEmail(...)` after
 * the transaction commits) so a mail provider outage never blocks an invite
 * or a webhook.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Idempotency key for the provider — same key, same email, never sent twice. */
  idempotencyKey?: string;
  tags?: Record<string, string>;
};

export type EmailTransport = {
  name: string;
  send(msg: EmailMessage): Promise<{ id: string | null }>;
};

const consoleTransport: EmailTransport = {
  name: "console",
  async send(msg) {
    console.log(`[email] to=${msg.to} subject="${msg.subject}"\n${msg.text}\n`);
    return { id: null };
  },
};

let resendClient: Resend | undefined;
const resendTransport: EmailTransport = {
  name: "resend",
  async send(msg) {
    resendClient ??= new Resend(process.env.RESEND_API_KEY);
    const from = process.env.EMAIL_FROM ?? "Orbit <onboarding@resend.dev>";
    const { data, error } = await resendClient.emails.send(
      {
        from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        tags: msg.tags ? Object.entries(msg.tags).map(([name, value]) => ({ name, value })) : undefined,
      },
      msg.idempotencyKey ? { idempotencyKey: msg.idempotencyKey } : undefined,
    );
    if (error) throw new Error(`Resend: ${error.name}: ${error.message}`);
    return { id: data?.id ?? null };
  },
};

let override: EmailTransport | null = null;

/** Tests: capture instead of sending. Returns a restore function. */
export function setEmailTransport(t: EmailTransport | null) {
  override = t;
  return () => {
    override = null;
  };
}

export function emailTransport(): EmailTransport {
  if (override) return override;
  return process.env.RESEND_API_KEY ? resendTransport : consoleTransport;
}

export async function sendEmail(msg: EmailMessage): Promise<{ id: string | null }> {
  try {
    return await emailTransport().send(msg);
  } catch (e) {
    // Never let a mail failure surface to the user path; it's logged for ops.
    console.error("[email] send failed", msg.subject, msg.to, e);
    return { id: null };
  }
}
