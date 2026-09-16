import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/org";
import { acceptInvitation, previewInvitation, type InviteFailure } from "@/lib/invites";
import { Button, Card } from "@/components/ui";

export const metadata = { title: "Invitation" };

const REASONS: Record<InviteFailure, string> = {
  malformed: "This invitation link is not valid.",
  bad_signature: "This invitation link has been tampered with or is not valid.",
  expired: "This invitation has expired. Ask for a new one.",
  not_found: "This invitation no longer exists.",
  not_pending: "This invitation has already been used or was revoked.",
  email_mismatch: "This invitation was sent to a different email address.",
  member_limit: "This organisation has reached the member limit of its plan. Ask an owner to upgrade.",
};

export default async function InvitePage({ params, searchParams }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const { error } = await searchParams;
  const user = await getUser();

  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`);
  }

  const preview = await previewInvitation(token);

  async function accept() {
    "use server";
    const u = await getUser();
    if (!u) redirect("/login");
    const r = await acceptInvitation(token, u);
    if (r.ok) redirect(`/app/${r.organisation.slug}`);
    redirect(`/invite/${token}?error=${r.reason}`);
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm text-center">
        {!preview.ok ? (
          <>
            <h1 className="mb-2 text-xl font-semibold">Invitation unavailable</h1>
            <p className="text-sm text-zinc-600">{REASONS[preview.reason]}</p>
          </>
        ) : (
          <>
            <p className="text-sm text-zinc-500">You&apos;ve been invited to join</p>
            <h1 className="mb-1 text-2xl font-semibold">{preview.invitation.organisation.name}</h1>
            <p className="mb-6 text-sm text-zinc-500">
              as <span className="font-medium">{preview.invitation.role.toLowerCase()}</span>
            </p>
            {preview.invitation.email !== user.email.toLowerCase() ? (
              <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                This invitation is for <b>{preview.invitation.email}</b>, but you are signed in as{" "}
                <b>{user.email}</b>.
              </p>
            ) : (
              <form action={accept}>
                <Button type="submit" className="w-full">
                  Accept invitation
                </Button>
              </form>
            )}
            {typeof error === "string" && error in REASONS && (
              <p className="mt-3 text-sm text-red-600">{REASONS[error as InviteFailure]}</p>
            )}
          </>
        )}
        <Link href="/app" className="mt-6 block text-sm text-zinc-500 hover:underline">
          Go to my organisations
        </Link>
      </Card>
    </main>
  );
}
