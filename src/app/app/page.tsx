import { redirect } from "next/navigation";
import { listUserOrgs, requireUser } from "@/lib/org";

/** /app — send the user to their first org, or to onboarding if they have none. */
export default async function AppIndex() {
  const user = await requireUser();
  const orgs = await listUserOrgs(user.id);
  redirect(orgs[0] ? `/app/${orgs[0].slug}` : "/onboarding");
}
