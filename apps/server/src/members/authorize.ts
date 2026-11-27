import {
  type Member,
  type MemberRole,
  memberGlobalRole,
  memberRoleOn,
  roleAtLeast,
} from "@codeden/contracts";
import type { Principal } from "./principal";

/**
 * What an action is about (§B.3):
 * - `server`: administering the server itself (settings, members, secrets): the server-wide role.
 * - `global`: work across projects (the orchestrator, reports, bulk changes): the lowest role the
 *   member has anywhere, so nothing about a hidden project reaches it this way.
 * - `project`: one project's work; `projectId: null` is work outside any project (global).
 * - `own`: the member's own orchestrator (§D.1), which acts for them project by project and
 *   shows only what they can see: the highest role they have anywhere.
 */
export type AuthTarget =
  | { kind: "server" }
  | { kind: "global" }
  | { kind: "own" }
  | { kind: "project"; projectId: string | null };

export type AuthDecision =
  | { ok: true }
  /** 404 for a project the member can't see (its existence isn't revealed); 403 otherwise. */
  | { ok: false; status: 403 | 404; code: "forbidden" | "not_found"; message: string };

export interface AuthorizeContext {
  /** Every project id (archived too), for the global role. */
  projectIds(): readonly string[];
}

const ROLE_NAME: Record<MemberRole, string> = {
  none: "access",
  viewer: "Viewer access",
  operator: "an Operator",
  owner: "an Owner",
};

/** The member's role for a target. */
export function roleFor(member: Member, target: AuthTarget, ctx: AuthorizeContext): MemberRole {
  switch (target.kind) {
    case "server":
      return member.disabled ? "none" : member.role;
    case "global":
      return memberGlobalRole(member, ctx.projectIds());
    case "own":
      if (member.disabled) return "none";
      return [member.role, ...Object.values(member.projectRoles)].reduce((a, b) =>
        roleAtLeast(a, b) ? a : b,
      );
    case "project":
      return target.projectId === null
        ? memberGlobalRole(member, ctx.projectIds())
        : memberRoleOn(member, target.projectId);
  }
}

/**
 * The one authorization check (§B.3), used by every HTTP route (through the route table), every
 * UI WebSocket message and every member tool. The server decides; the UI only hides what this
 * would refuse.
 */
export function authorize(
  principal: Principal,
  need: MemberRole,
  target: AuthTarget,
  ctx: AuthorizeContext,
): AuthDecision {
  const role = roleFor(principal.member, target, ctx);
  if (roleAtLeast(role, need)) return { ok: true };
  if (target.kind === "project" && target.projectId !== null && role === "none") {
    return { ok: false, status: 404, code: "not_found", message: "Not found" };
  }
  const where = target.kind === "project" && target.projectId !== null ? " on this project" : "";
  return {
    ok: false,
    status: 403,
    code: "forbidden",
    message: `This needs ${ROLE_NAME[need]}${where}. Ask an owner for a role.`,
  };
}

/** Can the member see this project at all? */
export function canSee(member: Member, projectId: string | null, ctx: AuthorizeContext): boolean {
  return roleAtLeast(roleFor(member, { kind: "project", projectId }, ctx), "viewer");
}

/**
 * An owner everywhere: nothing is filtered or checked further. Single-user installs (the install
 * token is the first owner) always are, so they behave exactly as before members.
 */
export function ownsEverything(member: Member): boolean {
  return (
    !member.disabled &&
    member.role === "owner" &&
    Object.values(member.projectRoles).every((r) => r === "owner")
  );
}
