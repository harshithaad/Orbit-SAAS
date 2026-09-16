import { redirect } from "next/navigation";
import { auth, devLoginEnabled, signIn } from "@/auth";
import { Button, Card, Input, Label } from "@/components/ui";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await auth()) redirect("/app");
  const { callbackUrl, error } = await searchParams;
  const redirectTo = typeof callbackUrl === "string" ? callbackUrl : "/app";
  const emailEnabled = Boolean(process.env.RESEND_API_KEY);

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold">Sign in to Orbit</h1>
        <p className="mb-6 text-sm text-zinc-500">Use GitHub or a magic link.</p>
        {error && (
          <p className="mb-4 rounded-md bg-red-50 p-2 text-sm text-red-700">
            Sign-in failed ({String(error)}). Try again.
          </p>
        )}

        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo });
          }}
        >
          <Button type="submit" className="w-full">
            Continue with GitHub
          </Button>
        </form>

        {emailEnabled && (
          <form
            className="mt-4 space-y-3 border-t border-zinc-200 pt-4"
            action={async (fd) => {
              "use server";
              await signIn("resend", { email: String(fd.get("email")), redirectTo });
            }}
          >
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required placeholder="you@company.com" />
            <Button type="submit" variant="secondary" className="w-full">
              Email me a magic link
            </Button>
          </form>
        )}

        {devLoginEnabled && (
          <form
            className="mt-4 space-y-3 border-t border-dashed border-amber-300 pt-4"
            action={async (fd) => {
              "use server";
              await signIn("dev", { email: String(fd.get("email")), redirectTo });
            }}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-amber-700">
              Dev login (local only)
            </p>
            <Input name="email" type="email" required placeholder="dev@example.com" />
            <Button type="submit" variant="secondary" className="w-full">
              Sign in without password
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
