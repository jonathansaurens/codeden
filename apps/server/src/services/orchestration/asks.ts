import {
  type AgentEventOf,
  type Item,
  OWNER_MEMBER_ID,
  type RawEventEnvelope,
  type Session,
} from "@codeden/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { items } from "../../db/schema";

/** The marker that ties a PM turn to an `ask_pm` call. */
export const askMarker = (askId: string) => `(ask ${askId})`;

export type AskOutcome = { status: "answered"; text: string } | { status: "pending" };

interface Waiter {
  askId: string;
  pmSessionId: string;
  projectId: string;
  fromSessionId: string | null;
  /** The person whose orchestrator asked (§D.3): the answer goes to their orchestrator only. */
  askedFor: string;
  /**
   * CodeDen handed the question to the PM (`delivering`): only then may a turn whose input
   * carries the marker answer it, so a marker someone typed into the PM's chat answers nothing.
   */
  armed: boolean;
  turnId: string | undefined;
  /** Set while an `ask_pm` call is waiting. */
  resolve: ((text: string) => void) | undefined;
  /** The call timed out: the reply is delivered to the orchestrator as a message. */
  late: boolean;
  createdAt: number;
}

/** An answer the `ask_pm` call didn't wait for; it reaches the orchestrator as a message. */
export interface LateReply {
  askId: string;
  projectId: string;
  pmSessionId: string;
  text: string;
  /** The person whose orchestrator asked (§D.3): their orchestrator alone gets the answer. */
  askedFor: string;
}

export interface PmAsksDeps {
  db: Db;
  /** A session by id (to tell PMs from other sessions). */
  session: (sessionId: string) => Session | undefined;
  /** A reply that arrived after the `ask_pm` call gave up, or that no call waits for. */
  onLateReply: (reply: LateReply) => void;
}

/** Asks answered recently (kept so a turn's answer is never sent twice). */
const SETTLED_LIMIT = 500;

const MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * `ask_pm` replies (§8.3). The question goes to the PM as a message carrying a marker; the
 * PM's turn that handles it is found by the marker in its user message, and the final
 * assistant message of that turn is the answer (or a `message_orchestrator` call with
 * `replyTo`, whichever comes first). If the call times out, the answer still reaches the
 * orchestrator later, as a message.
 *
 * Only asks CodeDen recorded here are ever answered, and only by a turn CodeDen delivered the
 * question to: a marker in a message someone wrote to the PM, or in a turn after a restart (the
 * record is in memory), answers nothing and reaches no orchestrator.
 */
export class PmAsks {
  private readonly waiters = new Map<string, Waiter>();
  private readonly settled = new Set<string>();

  constructor(private readonly deps: PmAsksDeps) {}

  /**
   * Track an ask. A `detached` ask has no call waiting for it (the loop guard held the
   * question back): its answer reaches the orchestrator as a message.
   */
  register(
    askId: string,
    target: {
      pmSessionId: string;
      projectId: string;
      fromSessionId: string | null;
      /** The person the asking orchestrator acts for; else the asking session's person. */
      askedFor?: string;
    },
    opts: { detached?: boolean } = {},
  ): void {
    this.prune();
    const asker = target.fromSessionId ? this.deps.session(target.fromSessionId) : undefined;
    // No person known (no asking session recorded): the first owner's, as every orchestrator's
    // before people had their own.
    const askedFor =
      target.askedFor ??
      (asker?.role === "orchestrator" ? asker.ownerMemberId : undefined) ??
      OWNER_MEMBER_ID;
    this.waiters.set(askId, {
      askId,
      ...target,
      askedFor,
      armed: false,
      turnId: undefined,
      resolve: undefined,
      late: opts.detached ?? false,
      createdAt: Date.now(),
    });
  }

  /**
   * A PM moved to a new session, which took over its queued messages (its provider was
   * switched): the asks still open for the old session are answered by the new one's turns.
   */
  retarget(fromSessionId: string, toSessionId: string): void {
    for (const waiter of this.waiters.values()) {
      if (waiter.pmSessionId === fromSessionId) waiter.pmSessionId = toSessionId;
    }
  }

  /**
   * CodeDen is handing `texts` to a PM session: the question of a recorded ask among them (an
   * `ask_pm` message, or a held-back one delivered with a wake) may now be answered by the turn
   * that carries it.
   */
  delivering(pmSessionId: string, texts: readonly string[]): void {
    for (const w of this.waiters.values()) {
      if (w.pmSessionId !== pmSessionId || w.turnId) continue;
      if (texts.some((t) => t.includes(askMarker(w.askId)))) w.armed = true;
    }
  }

  /** Wait for the answer to a registered ask. */
  wait(askId: string, timeoutMs: number, signal?: AbortSignal): Promise<AskOutcome> {
    const waiter = this.waiters.get(askId);
    if (!waiter) return Promise.resolve({ status: "pending" });
    return new Promise<AskOutcome>((resolve) => {
      const done = (outcome: AskOutcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiter.resolve = undefined;
        resolve(outcome);
      };
      const giveUp = () => {
        waiter.late = true;
        done({ status: "pending" });
      };
      const onAbort = () => giveUp();
      const timer = setTimeout(giveUp, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      waiter.resolve = (text) => done({ status: "answered", text });
    });
  }

  /** An explicit reply (`message_orchestrator` with `replyTo`). True when it matched an ask. */
  answer(askId: string, text: string): boolean {
    const waiter = this.waiters.get(askId);
    if (!waiter) return false;
    this.finish(waiter, text);
    return true;
  }

  /** Follow committed events: find the answering turn, then its final message. */
  onEvents(events: RawEventEnvelope[]): void {
    if (this.waiters.size === 0) return;
    for (const e of events) {
      if (!e.sessionId) continue;
      if (e.type === "agent.item.started" || e.type === "agent.item.completed") {
        const event = e.payload as AgentEventOf<"item.completed">;
        const item: Item = event.item;
        if (item.kind !== "user_message") continue;
        for (const w of this.waiters.values()) {
          if (
            w.pmSessionId === e.sessionId &&
            w.armed &&
            !w.turnId &&
            item.input.text.includes(askMarker(w.askId))
          ) {
            w.turnId = event.turnId;
          }
        }
      } else if (
        e.type === "agent.turn.completed" ||
        e.type === "agent.turn.failed" ||
        e.type === "agent.turn.interrupted"
      ) {
        const event = e.payload as AgentEventOf<"turn.completed">;
        for (const w of [...this.waiters.values()]) {
          if (w.pmSessionId !== e.sessionId || w.turnId !== event.turnId) continue;
          const text =
            this.finalMessage(w.pmSessionId, event.turnId) ??
            (e.type === "agent.turn.completed"
              ? "(The PM finished without a reply.)"
              : "(The PM's turn ended before it replied.)");
          this.finish(w, text);
        }
      }
    }
  }

  /** Whether any ask is still waiting for its turn (tests). */
  get size(): number {
    return this.waiters.size;
  }

  private finish(waiter: Waiter, text: string): void {
    this.waiters.delete(waiter.askId);
    this.settle(waiter.askId);
    if (waiter.resolve) waiter.resolve(text);
    else if (waiter.late) {
      const { askId, projectId, pmSessionId, askedFor } = waiter;
      setImmediate(() =>
        this.deps.onLateReply({
          askId,
          projectId,
          pmSessionId,
          text,
          askedFor,
        }),
      );
    }
  }

  private settle(askId: string): void {
    this.settled.add(askId);
    if (this.settled.size <= SETTLED_LIMIT) return;
    const oldest = this.settled.values().next().value;
    if (oldest !== undefined) this.settled.delete(oldest);
  }

  private finalMessage(sessionId: string, turnId: string): string | null {
    return finalAssistantMessage(this.deps.db, sessionId, turnId);
  }

  private prune(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [id, w] of this.waiters)
      if (w.createdAt < cutoff && !w.resolve) this.waiters.delete(id);
  }
}

/** Final assistant message of a turn (shared with notice derivation). */
export function finalAssistantMessage(db: Db, sessionId: string, turnId: string): string | null {
  const rows = db
    .select()
    .from(items)
    .where(
      and(
        eq(items.sessionId, sessionId),
        eq(items.turnId, turnId),
        eq(items.kind, "assistant_message"),
      ),
    )
    .orderBy(desc(items.position))
    .limit(5)
    .all();
  for (const row of rows) {
    if (row.data.kind === "assistant_message" && row.data.text.trim()) return row.data.text.trim();
  }
  return null;
}
