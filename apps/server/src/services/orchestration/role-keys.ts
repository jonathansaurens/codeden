import { OWNER_MEMBER_ID, type Session } from "@codeden/contracts";

/**
 * Whose a role is (`docs/machines-teams-and-agents.md` §D.1): a PM belongs to its project, an
 * orchestrator to its person. The first owner's orchestrator is stored as it always was (no
 * owner recorded, `null` here), so single-user installs need no change to their data.
 */

/** A person's orchestrator key: `null` for the first owner. */
export function personKey(memberId: string | null | undefined): string | null {
  return !memberId || memberId === OWNER_MEMBER_ID ? null : memberId;
}

/** The member a person key stands for. */
export function memberOfKey(key: string | null): string {
  return key ?? OWNER_MEMBER_ID;
}

/** What a role session belongs to: its project (a PM) or its person (an orchestrator). */
export function roleScopeOf(session: Pick<Session, "role" | "projectId" | "ownerMemberId">) {
  return session.role === "orchestrator" ? personKey(session.ownerMemberId) : session.projectId;
}

/** Scheduler key of a notice target: a project's PM, or a person's orchestrator. */
export function wakeKey(
  target: "pm" | "orchestrator",
  projectId: string | null,
  memberId?: string | null,
): string {
  if (target === "pm") return `pm:${projectId ?? ""}`;
  const person = personKey(memberId);
  return person ? `orchestrator:${person}` : "orchestrator";
}

/** The target a scheduler key names (`wakeKey`). */
export function parseWakeKey(
  key: string,
): { role: "pm"; projectId: string } | { role: "orchestrator"; person: string | null } {
  if (key.startsWith("pm:")) return { role: "pm", projectId: key.slice(3) };
  return { role: "orchestrator", person: key.startsWith("orchestrator:") ? key.slice(13) : null };
}
