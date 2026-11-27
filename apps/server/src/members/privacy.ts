import { type Member, OWNER_MEMBER_ID } from "@codeden/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions } from "../db/schema";

/**
 * Orchestrators are private (`docs/machines-teams-and-agents.md` §D.1): each person's is theirs
 * alone, and not even Owners read another's. Connected agents have none. Every way a session can
 * be read (the snapshot, session routes, transcripts, search, the live streams) leaves out the
 * orchestrators that aren't the member's own.
 */
export interface Privacy {
  /** Orchestrator sessions (retired ones too) that aren't the member's. */
  hidden: ReadonlySet<string>;
  /**
   * The member's own orchestrator sessions (retired ones too): outside any project, so they are
   * seen with the member's `own` role, not the lowest one a hidden project gives.
   */
  own?: ReadonlySet<string>;
}

/** The member an orchestrator session belongs to (no owner recorded: the first owner). */
export function orchestratorMember(ownerMemberId: string | null | undefined): string {
  return ownerMemberId ?? OWNER_MEMBER_ID;
}

/** The orchestrator sessions a member may not read. */
export function privacyFor(db: Db, member: Member): Privacy {
  const rows = db
    .select({ id: sessions.id, owner: sessions.ownerMemberId })
    .from(sessions)
    .where(eq(sessions.role, "orchestrator"))
    .all();
  const hidden = new Set<string>();
  const own = new Set<string>();
  for (const row of rows) {
    if (member.kind === "agent" || orchestratorMember(row.owner) !== member.id) hidden.add(row.id);
    else own.add(row.id);
  }
  return { hidden, own };
}

/** Whether a session is someone else's orchestrator, for this member. */
export function isPrivateSession(db: Db, member: Member, sessionId: string): boolean {
  const row = db
    .select({ role: sessions.role, owner: sessions.ownerMemberId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (row?.role !== "orchestrator") return false;
  return member.kind === "agent" || orchestratorMember(row.owner) !== member.id;
}

/**
 * Whether a session is the member's own orchestrator (a person's; connected agents have none).
 * It belongs to no project, so its routes and streams check the member's `own` role (the highest
 * they have anywhere), never the lowest one a hidden project would give.
 */
export function isOwnOrchestrator(db: Db, member: Member, sessionId: string): boolean {
  if (member.kind === "agent") return false;
  const row = db
    .select({ role: sessions.role, owner: sessions.ownerMemberId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  return row?.role === "orchestrator" && orchestratorMember(row.owner) === member.id;
}
