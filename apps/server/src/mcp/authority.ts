import { type MemberRole, type Role, roleAtLeast } from "@codeden/contracts";
import { type ActingFor, actingCanSee, actingRole } from "../members/acting";
import type { AuthTarget } from "../members/authorize";
import { currentPrincipal } from "../members/principal";
import { authorizeContext } from "../members/sockets";
import type { AppServices } from "../services/container";
import { ToolError } from "./define";

/**
 * The authority of a role agent's tool call (`docs/machines-teams-and-agents.md` §D.2): the
 * orchestrator and the PMs act with the role of the people their turn acts for, checked by the
 * same rules as a person's request. Agent sessions' tools aren't checked this way.
 */

/** Who calls a tool: the token's role and session, through MCP or an API handler. */
export interface AuthorityCaller {
  role: Role;
  caller: "mcp" | "ui";
  sessionId: string | null;
}

/** What a tool needs from the turn that calls it (`ServerTool.authority`). */
export interface ToolNeed<I = unknown> {
  need: MemberRole;
  /** What it does, for the refusal: "Only an Owner can <action>". */
  action: string;
  /**
   * What the role is checked on: `server` (the server-wide role), or what the input names (a
   * project: `inputProject`). Default: the caller's project (a PM's), else work across projects.
   */
  on?: "server" | ((input: I, caller: { projectId: string | null }) => AuthTarget);
}

const ROLE_LABEL: Record<MemberRole, string> = {
  none: "no role",
  viewer: "a Viewer",
  operator: "an Operator",
  owner: "an Owner",
};

/** The people a tool call acts for; `null`: CodeDen's own work, which acts as an Owner. */
export function actingForCall(services: AppServices, caller: AuthorityCaller): ActingFor {
  if (caller.caller === "ui") {
    const member = currentPrincipal()?.member;
    return member ? [member] : null;
  }
  if (caller.role !== "orchestrator" && caller.role !== "pm") return null;
  const session = caller.sessionId ? services.sessionRepo.find(caller.sessionId)?.session : null;
  if (!session) return caller.role === "orchestrator" ? [services.members.owner()] : null;
  return services.orchestration.actingFor(session);
}

/** Whether the people a call acts for may see a project (list and digest tools filter by it). */
export function callerCanSee(
  services: AppServices,
  caller: AuthorityCaller,
): (projectId: string | null) => boolean {
  const people = actingForCall(services, caller);
  if (people === null) return () => true;
  const ctx = authorizeContext(services);
  return (projectId) => actingCanSee(people, projectId, ctx);
}

/**
 * Refuse the call unless the people it acts for have `need` on `target`. A project hidden from
 * them is answered as one that doesn't exist; otherwise the refusal names the role needed, so
 * the agent tells the person instead of trying again.
 */
export function assertAuthority(
  services: AppServices,
  caller: AuthorityCaller,
  need: MemberRole,
  target: AuthTarget,
  action: string,
): void {
  const people = actingForCall(services, caller);
  const ctx = authorizeContext(services);
  const role = actingRole(people, target, ctx);
  if (roleAtLeast(role, need)) return;
  if (target.kind === "project" && target.projectId !== null && role === "none") {
    throw new ToolError(`No project ${target.projectId}. Call list_projects for the ids.`);
  }
  const where = target.kind === "project" && target.projectId !== null ? " on this project" : "";
  const short = (people ?? []).filter((m) => !roleAtLeast(actingRole([m], target, ctx), need));
  const who = short.map((m) => `${m.name} (${ROLE_LABEL[actingRole([m], target, ctx)]})`);
  const label = ROLE_LABEL[need];
  throw new ToolError(
    `Only ${label} can ${action}${where}; this turn acts for ${who.join(", ") || "nobody with a role"}. Nothing was done: tell them to ask ${label}, and don't try again in this turn.`,
  );
}

/** `ToolNeed.on` for a tool whose input names the project (`projectId`). */
export const inputProject = (input: { projectId: string }): AuthTarget => ({
  kind: "project",
  projectId: input.projectId,
});

/** The target a tool's need names for this call. */
export function needTarget<I>(
  need: ToolNeed<I>,
  input: I,
  caller: { projectId: string | null },
): AuthTarget {
  if (need.on === "server") return { kind: "server" };
  if (need.on) return need.on(input, caller);
  return caller.projectId ? { kind: "project", projectId: caller.projectId } : { kind: "global" };
}
