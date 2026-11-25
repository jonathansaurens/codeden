import {
  type MemberRole,
  type MemberSummary,
  type MeResponse,
  OWNER_MEMBER_ID,
  roleAtLeast,
} from "@codeden/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useClient } from "./api";

export const meKey = ["members", "me"] as const;
export const memberSummariesKey = ["members", "summaries"] as const;
export const membersKey = ["members", "list"] as const;

/** Who this device is signed in as, and its roles (§B.3). */
export function useMe() {
  const client = useClient();
  return useQuery({ queryKey: meKey, queryFn: () => client.members.me(), staleTime: 30_000 });
}

/** Everyone's names, for attribution and presence (§B.4). */
export function useMemberNames(): ReadonlyMap<string, MemberSummary> {
  const client = useClient();
  const { data } = useQuery({
    queryKey: memberSummariesKey,
    queryFn: () => client.members.summaries(),
    staleTime: 60_000,
  });
  return useMemo(() => new Map((data?.members ?? []).map((m) => [m.id, m])), [data]);
}

/** A member's display name, or a short placeholder for one that is gone. */
export function memberName(names: ReadonlyMap<string, MemberSummary>, id: string): string {
  return names.get(id)?.name ?? (id === OWNER_MEMBER_ID ? "Owner" : "A former member");
}

/** The caller's role on a project (null: work across projects, the orchestrator). */
export function roleOn(me: MeResponse | undefined, projectId: string | null): MemberRole {
  // Until `me` loads, assume what a single-user install is: the owner.
  if (!me) return "owner";
  if (projectId === null) return me.globalRole;
  return me.projectRoles[projectId] ?? "none";
}

/**
 * May the caller do something that needs `need` on `projectId`? The server decides; this only
 * hides what it would refuse (§B.3).
 */
export function useCan(need: MemberRole, projectId: string | null | undefined): boolean {
  const { data } = useMe();
  if (projectId === undefined) return roleAtLeast(data ? data.member.role : "owner", need);
  return roleAtLeast(roleOn(data, projectId), need);
}

export const ROLE_LABEL: Record<MemberRole, string> = {
  none: "No access",
  viewer: "Viewer",
  operator: "Operator",
  owner: "Owner",
};
