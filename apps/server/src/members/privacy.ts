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
  for (const row of rows) {
    if (member.kind === "agent" || orchestratorMember(row.owner) !== member.id) hidden.add(row.id);
  }
  return { hidden };
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
