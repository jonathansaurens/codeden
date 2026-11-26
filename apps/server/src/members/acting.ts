import { type Member, type MemberRole, roleAtLeast } from "@codeden/contracts";
import { type AuthorizeContext, type AuthTarget, roleFor } from "./authorize";

/**
 * Who a role agent's turn acts for (`docs/machines-teams-and-agents.md` §D.2), as members: the
 * people whose messages started it, or `null` for CodeDen's own work (a turn only automatic
 * events started), which acts as an Owner. Their role on a target is the lowest of theirs, by
 * the same rules as a person's request (`authorize.ts`).
 */
export type ActingFor = readonly Member[] | null;

/** Looks members up (`MemberService`). */
export interface MemberLookup {
  find(id: string): Member | undefined;
  owner(): Member;
  list(): Member[];
}

/** A member who was deleted (or never existed): no role anywhere. */
function former(id: string): Member {
  return {
    id,
    kind: "person",
    name: "a former member",
    role: "none",
    projectRoles: {},
    disabled: true,
    mayAnswerApprovals: false,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** The members with these ids, as they are now; one that no longer exists has no role. */
export function membersOf(members: Pick<MemberLookup, "find">, ids: readonly string[]): Member[] {
  return ids.map((id) => members.find(id) ?? former(id));
}

/** The lowest role the people have on `target`; CodeDen's own work (`null`) acts as an Owner. */
export function actingRole(
  people: ActingFor,
  target: AuthTarget,
  ctx: AuthorizeContext,
): MemberRole {
  if (people === null) return "owner";
  let lowest: MemberRole = "owner";
  for (const member of people) {
    const role = roleFor(member, target, ctx);
    if (!roleAtLeast(role, lowest)) lowest = role;
  }
  return people.length === 0 ? "none" : lowest;
}

/** Whether every one of the people may see the project (`null`: work across projects). */
export function actingCanSee(
  people: ActingFor,
  projectId: string | null,
  ctx: AuthorizeContext,
): boolean {
  return roleAtLeast(actingRole(people, { kind: "project", projectId }, ctx), "viewer");
}
