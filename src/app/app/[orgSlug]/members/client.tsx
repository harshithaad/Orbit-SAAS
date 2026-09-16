"use client";

import { useActionState, useState, useTransition } from "react";
import { Button, ErrorText, Input, Label } from "@/components/ui";
import {
  changeRoleAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInviteAction,
  type ActionState,
} from "./actions";

export function InviteForm({ orgSlug }: { orgSlug: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    inviteMemberAction.bind(null, orgSlug),
    {},
  );
  return (
    <form action={action} className="space-y-3">
      <div>
        <Label htmlFor="invite-email">Email</Label>
        <Input id="invite-email" name="email" type="email" required placeholder="teammate@company.com" />
      </div>
      <div>
        <Label htmlFor="invite-role">Role</Label>
        <select
          id="invite-role"
          name="role"
          defaultValue="MEMBER"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
        >
          <option value="MEMBER">Member</option>
          <option value="ADMIN">Admin</option>
        </select>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create invite link"}
      </Button>
      <ErrorText>{state.error}</ErrorText>
      {state.inviteUrl && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs">
          <p className="mb-1 font-medium text-emerald-800">Invite link created</p>
          <code className="block break-all text-emerald-900">{state.inviteUrl}</code>
        </div>
      )}
    </form>
  );
}

export function MemberRow(props: {
  orgSlug: string;
  userId: string;
  email: string;
  name: string | null;
  role: string;
  isSelf: boolean;
  roleOptions: readonly string[];
  removable: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const run = (p: Promise<ActionState>) =>
    start(async () => {
      const r = await p;
      setError(r.error);
    });

  return (
    <tr>
      <td className="px-6 py-3">
        <div className="font-medium">{props.name ?? props.email}</div>
        <div className="text-xs text-zinc-500">
          {props.email}
          {props.isSelf && " (you)"}
        </div>
      </td>
      <td className="px-6 py-3">
        {props.roleOptions.length > 0 ? (
          <select
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm"
            value={props.role}
            disabled={pending}
            onChange={(e) => run(changeRoleAction(props.orgSlug, props.userId, e.target.value))}
          >
            {[props.role, ...props.roleOptions].map((r) => (
              <option key={r} value={r}>
                {r.toLowerCase()}
              </option>
            ))}
          </select>
        ) : (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium">
            {props.role.toLowerCase()}
          </span>
        )}
        <ErrorText>{error}</ErrorText>
      </td>
      <td className="px-6 py-3 text-right">
        {props.removable && (
          <button
            className="text-sm text-red-600 hover:underline disabled:opacity-50"
            disabled={pending}
            onClick={() => {
              if (confirm(props.isSelf ? "Leave this organisation?" : `Remove ${props.email}?`)) {
                run(removeMemberAction(props.orgSlug, props.userId));
              }
            }}
          >
            {props.isSelf ? "Leave" : "Remove"}
          </button>
        )}
      </td>
    </tr>
  );
}

export function PendingInviteRow(props: {
  orgSlug: string;
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}) {
  const [pending, start] = useTransition();
  return (
    <li className="flex items-center justify-between py-2">
      <div>
        <div className="font-medium">{props.email}</div>
        <div className="text-xs text-zinc-500">
          {props.role.toLowerCase()} · expires {new Date(props.expiresAt).toLocaleDateString()}
        </div>
      </div>
      <button
        className="text-sm text-red-600 hover:underline disabled:opacity-50"
        disabled={pending}
        onClick={() => start(async () => void (await revokeInviteAction(props.orgSlug, props.id)))}
      >
        Revoke
      </button>
    </li>
  );
}
