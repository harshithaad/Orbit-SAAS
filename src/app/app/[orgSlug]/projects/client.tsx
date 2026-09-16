"use client";

import { useActionState, useRef, useTransition } from "react";
import { Button, ErrorText, Input, Label } from "@/components/ui";
import { createProjectAction, deleteProjectAction, type ActionState } from "./actions";

export function NewProjectForm({ orgSlug }: { orgSlug: string }) {
  const ref = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<ActionState, FormData>(
    async (prev, fd) => {
      const r = await createProjectAction(orgSlug, prev, fd);
      if (r.ok) ref.current?.reset();
      return r;
    },
    {},
  );
  return (
    <form ref={ref} action={action} className="space-y-3">
      <div>
        <Label htmlFor="p-name">Name</Label>
        <Input id="p-name" name="name" required maxLength={80} placeholder="Website redesign" />
      </div>
      <div>
        <Label htmlFor="p-desc">Description</Label>
        <Input id="p-desc" name="description" maxLength={500} placeholder="Optional" />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create project"}
      </Button>
      <ErrorText>{state.error}</ErrorText>
    </form>
  );
}

export function ProjectRow(props: {
  orgSlug: string;
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  canDelete: boolean;
}) {
  const [pending, start] = useTransition();
  return (
    <li className="flex items-center justify-between px-6 py-3">
      <div>
        <p className="font-medium">{props.name}</p>
        <p className="text-xs text-zinc-500">
          {props.description ? `${props.description} · ` : ""}
          created {new Date(props.createdAt).toLocaleDateString()}
        </p>
      </div>
      {props.canDelete && (
        <button
          className="text-sm text-red-600 hover:underline disabled:opacity-50"
          disabled={pending}
          onClick={() => {
            if (confirm(`Delete "${props.name}"?`)) {
              start(async () => void (await deleteProjectAction(props.orgSlug, props.id)));
            }
          }}
        >
          Delete
        </button>
      )}
    </li>
  );
}
