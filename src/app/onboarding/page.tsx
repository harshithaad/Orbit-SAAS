import { requireUser } from "@/lib/org";
import { Card } from "@/components/ui";
import { CreateOrgForm } from "./form";

export const metadata = { title: "Create organisation" };

export default async function OnboardingPage() {
  const user = await requireUser();
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold">Create your organisation</h1>
        <p className="mb-6 text-sm text-zinc-500">
          Signed in as {user.email}. You&apos;ll be the owner.
        </p>
        <CreateOrgForm />
      </Card>
    </main>
  );
}
