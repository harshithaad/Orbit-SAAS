import Link from "next/link";
import { Card } from "@/components/ui";

export default function Forbidden() {
  return (
    <Card className="mx-auto max-w-md text-center">
      <p className="text-2xl">⛔</p>
      <h1 className="mt-2 text-lg font-semibold">You don&apos;t have access to this page</h1>
      <p className="mt-1 text-sm text-zinc-500">Ask an owner or admin of this organisation.</p>
      <Link href="/app" className="mt-4 inline-block text-sm text-zinc-700 underline">
        Back to overview
      </Link>
    </Card>
  );
}
