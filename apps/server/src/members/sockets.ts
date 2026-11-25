import type { RawEventEnvelope, TerminalQuery } from "@codeden/contracts";
import { roleAtLeast } from "@codeden/contracts";
import type { AppServices } from "../services/container";
import { type AuthorizeContext, authorize, canSee, ownsEverything, roleFor } from "./authorize";
import type { Principal } from "./principal";
import { projectOfEntity } from "./visibility";

/**
 * Role checks for the UI WebSockets (§B.3): the event stream and transcripts show only the
 * projects a member can see, and Viewers' terminals and browser views are read-only. Every
 * check goes through `authorize`, like the HTTP routes.
 */

/** Global events that say nothing about any project's work. */
const NEUTRAL_EVENTS = new Set([
  "settings.updated",
  "member.created",
  "member.updated",
  "member.deleted",
  "projects.reordered",
  "pty.exited",
  "runner.registered",
  "runner.deleted",
  "runner.connected",
  "runner.disconnected",
  "runner.draining",
]);

/** A project id a domain event's payload names, if any. */
function payloadProject(payload: unknown): string | null | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const nested = (key: string): Record<string, unknown> | undefined =>
    p[key] && typeof p[key] === "object" ? (p[key] as Record<string, unknown>) : undefined;
  if (typeof p.projectId === "string" || p.projectId === null) return p.projectId as string | null;
  const project = nested("project");
  if (project && typeof project.id === "string") return project.id;
  for (const key of ["session", "item", "run", "conflict", "notice", "artifact"]) {
    const inner = nested(key);
    if (inner && (typeof inner.projectId === "string" || inner.projectId === null)) {
      return inner.projectId as string | null;
    }
  }
  const target = nested("automation")?.target as { type?: string; projectId?: string } | undefined;
  if (target) return target.type === "project" ? (target.projectId ?? null) : null;
  return undefined;
}

export function authorizeContext(s: AppServices): AuthorizeContext {
  return { projectIds: () => s.projects.list({ includeArchived: true }).map((p) => p.id) };
}

/**
 * Which events a member's socket may receive; undefined means all of them (an owner of
 * everything, so single-user installs stream exactly as before).
 */
export function eventFilterFor(
  s: AppServices,
  principal: Principal | undefined,
): ((e: RawEventEnvelope) => boolean) | undefined {
  if (!principal || ownsEverything(principal.member)) return undefined;
  const ctx = authorizeContext(s);
  const member = principal.member;
  const sessionProjects = new Map<string, string | null>();
  const projectOfSession = (id: string) => {
    if (!sessionProjects.has(id)) sessionProjects.set(id, projectOfEntity(s, "session", id));
    return sessionProjects.get(id) ?? null;
  };
  return (e) => {
    if (e.sessionId) {
      if (e.type === "session.created" || e.type === "session.updated") {
        const projectId = payloadProject(e.payload);
        if (projectId !== undefined) sessionProjects.set(e.sessionId, projectId);
      }
      return canSee(member, projectOfSession(e.sessionId), ctx);
    }
    if (NEUTRAL_EVENTS.has(e.type)) return true;
    const projectId = payloadProject(e.payload);
    if (projectId === undefined) {
      const sessionId = (e.payload as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId === "string") return canSee(member, projectOfSession(sessionId), ctx);
    }
    // Anything else that names no project is work across projects.
    return canSee(member, projectId ?? null, ctx);
  };
}

/** May this member watch a session's transcript? */
export function canWatchSession(
  s: AppServices,
  principal: Principal | undefined,
  sessionId: string,
): boolean {
  if (!principal || ownsEverything(principal.member)) return true;
  return canSee(principal.member, projectOfEntity(s, "session", sessionId), authorizeContext(s));
}

/** What a member may do with a session's terminal or browser: drive it, watch it, or nothing. */
export type SocketAccess = "full" | "read" | null;

function sessionAccess(s: AppServices, principal: Principal, sessionId: string): SocketAccess {
  const ctx = authorizeContext(s);
  const target = { kind: "project" as const, projectId: projectOfEntity(s, "session", sessionId) };
  if (authorize(principal, "operator", target, ctx).ok) return "full";
  return roleAtLeast(roleFor(principal.member, target, ctx), "viewer") ? "read" : null;
}

/**
 * Terminals (§B.3, open question 3: read-only for Viewers). A session's terminal: Operators
 * drive it, Viewers may attach to one that is open and watch. A terminal outside any session is
 * a shell on the server, so it is the server owners' alone.
 */
export function terminalAccess(
  s: AppServices,
  principal: Principal | undefined,
  query: TerminalQuery,
): SocketAccess {
  if (!principal) return null;
  // A connected agent works through the member tools, never a shell on the server (§C.3).
  if (principal.member.kind === "agent") return null;
  if (ownsEverything(principal.member)) return "full";
  if (!query.sessionId) {
    return authorize(principal, "owner", { kind: "server" }, authorizeContext(s)).ok
      ? "full"
      : null;
  }
  const access = sessionAccess(s, principal, query.sessionId);
  // Watching is attaching to an open terminal; opening one, or running a command, is acting.
  if (access === "read" && (!query.ptyId || query.command)) return null;
  return access;
}

/** The session browser: Operators drive it, Viewers watch its frames. */
export function browserAccess(
  s: AppServices,
  principal: Principal | undefined,
  sessionId: string,
): SocketAccess {
  if (!principal) return null;
  if (ownsEverything(principal.member)) return "full";
  const access = sessionAccess(s, principal, sessionId);
  // Connected agents may watch a session's browser, never drive it.
  return principal.member.kind === "agent" && access === "full" ? "read" : access;
}
