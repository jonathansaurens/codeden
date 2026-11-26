import {
  type AgentEventOf,
  agentEventToNewEvent,
  type RawEventEnvelope,
  ROLE_PLACEMENT_CODE,
  type RolePlacementData,
  type Session,
} from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import type { SessionRepo } from "../sessions/repo";

type Note = { data: RolePlacementData; message: string };

/**
 * The lines a role's chat shows about where it runs (§D.4): "Moved to vps-1", "vps-1 is offline;
 * this turn runs on the server…", "Back on vps-1" at the start of the new session's first turn,
 * and, when no device can take a message, a line in the session's latest turn saying it waits.
 */
export class RolePlacementNotes {
  private readonly pending = new Map<string, Note>();

  constructor(
    private readonly deps: {
      store: Pick<EventStore, "append">;
      repo: Pick<SessionRepo, "find" | "rootTurnIds">;
    },
  ) {}

  /** Shown when the session's first turn starts. */
  add(sessionId: string, note: Note): void {
    this.pending.set(sessionId, note);
  }

  onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (e.type !== "agent.turn.started" || !e.sessionId) continue;
      const note = this.pending.get(e.sessionId);
      if (!note) continue;
      this.pending.delete(e.sessionId);
      const event = e.payload as AgentEventOf<"turn.started">;
      this.append(e.sessionId, event.threadId, event.turnId, note, "info");
    }
  }

  /** Now, in the session's latest turn; nothing when it has had none yet. */
  now(session: Session, note: Note): void {
    const turnId = this.deps.repo.rootTurnIds(session).at(-1);
    if (!turnId || !session.rootThreadId) return;
    this.append(session.id, session.rootThreadId, turnId, note, "warning");
  }

  private append(
    sessionId: string,
    threadId: string,
    turnId: string,
    note: Note,
    level: "info" | "warning",
  ): void {
    this.deps.store.append([
      agentEventToNewEvent(sessionId, {
        type: "item.completed",
        threadId,
        turnId,
        item: {
          id: `role-placement-${turnId}-${note.data.reason}`,
          kind: "notice",
          status: "completed",
          level,
          code: ROLE_PLACEMENT_CODE,
          message: note.message,
          data: note.data,
        },
      }),
    ]);
  }
}
