"use client";

import { useActionState } from "react";
import { Button, ErrorText, Input, Label } from "@/components/ui";
import { createOrganisation, type CreateOrgState } from "./actions";

export function CreateOrgForm() {
  const [state, action, pending] = useActionState<CreateOrgState, FormData>(createOrganisation, {});
  return (
    <form action={action} className="space-y-4">
      <div>
        <Label htmlFor="name">Organisation name</Label>
        <Input id="name" name="name" required minLength={2} maxLength={60} placeholder="Acme Inc" autoFocus />
        <ErrorText>{state.error}</ErrorText>
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creating…" : "Create organisation"}
      </Button>
    </form>
  );
}
