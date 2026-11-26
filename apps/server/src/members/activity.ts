import type { Actor } from "@codeden/contracts";

/**
 * The events the activity list shows (§B.4): things a person or connected agent chose to do.
 * Events their actions set off (status changes, checkpoints, notices) carry the same actor and
 * would bury them.
 */
export const ACTIVITY_TYPES = [
  "settings.updated",
  "member.created",
  "member.updated",
  "member.deleted",
  "session.created",
  "message.queued",
  "turn.started",
  "inbox.updated",
  "project.created",
  "project.updated",
  "project.archived",
  "automation.saved",
  "automation.deleted",
] as const;

/**
 * `session.updated` is read too: a stop shows as `session.stopped`, and a switch to running as
 * `turn.started` (someone sent a message: the message itself is recorded later, by the runner,
 * without the sender).
 */
export const ACTIVITY_QUERY_TYPES = [...ACTIVITY_TYPES, "session.updated"];

export interface ActivityRow {
  seq: number;
  type: string;
  actor: Actor;
  sessionId: string | null;
  ts: string;
  payload: unknown;
}

export type ActivityEvent = Omit<ActivityRow, "payload">;

/** What a `session.updated` by this actor shows as, or null for none of the list's business. */
function updateType(row: ActivityRow): string | null {
  const session = (row.payload as { session?: { status?: string; stoppedBy?: Actor | null } })
    ?.session;
  if (session?.status === "stopped" && session.stoppedBy?.memberId === row.actor.memberId) {
    return "session.stopped";
  }
  return session?.status === "running" ? "turn.started" : null;
}

/**
 * The activity list from the newest rows first: stops and sends kept from `session.updated`,
 * the rest of it dropped, and runs of the same thing by the same actor on
 * the same session folded into one (a start's first turn, a burst of setting changes).
 */
export function activityOf(rows: ActivityRow[], limit: number): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    let type = row.type;
    if (type === "session.updated") {
      const shown = updateType(row);
      if (!shown) continue;
      type = shown;
    }
    const prev = out.at(-1);
    const sameActor = prev?.actor.memberId === row.actor.memberId;
    const sameSession = prev?.sessionId === row.sessionId;
    // Newest first: a session's first turn comes just before its start in this order.
    const startsTurn = prev?.type === "turn.started" && type === "session.created";
    if (prev && sameActor && sameSession && (prev.type === type || startsTurn)) {
      if (startsTurn) out[out.length - 1] = { ...prev, type, seq: row.seq };
      continue;
    }
    out.push({ seq: row.seq, type, actor: row.actor, sessionId: row.sessionId, ts: row.ts });
  }
  return out;
}
