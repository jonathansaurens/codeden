import {
  type MessageSender,
  type Notice,
  OWNER_MEMBER_ID,
  type Session,
  type UserInput,
} from "@codeden/contracts";
import type { SessionRepo } from "../sessions/repo";

/**
 * Who a role session's turn acts for (`docs/machines-teams-and-agents.md` §D.2): the people
 * whose messages are in it. The orchestrator's and the PMs' tools act with their role
 * (`mcp/authority.ts`); a turn only automatic events started acts as an Owner, as before.
 */
export interface TurnPeople {
  /**
   * Members whose messages are in the turn: people, connected agents, and the person an
   * orchestrator acts for when it wrote the message. Empty: only automatic events started it.
   */
  members: string[];
  /** The people whose orchestrators sent messages in the turn: its reports go to them (§D.3). */
  orchestrators: string[];
}

export const AUTOMATIC: TurnPeople = { members: [], orchestrators: [] };

/** Stands for a sender no member is known for: it has no role anywhere. */
export const UNKNOWN_MEMBER = "(unknown)";

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

function merge(a: TurnPeople, b: TurnPeople): TurnPeople {
  return {
    members: union(a.members, b.members),
    orchestrators: union(a.orchestrators, b.orchestrators),
  };
}

/**
 * The people one message speaks for: a person's or a connected agent's message is theirs (a
 * person's without an author is the first owner's: work that runs without a sign-in, as on a
 * single-user install); an orchestrator's is its person's. CodeDen's, a PM's, the factory's and
 * automations' messages are automatic.
 */
export function peopleOf(
  input: Pick<UserInput, "author" | "onBehalfOf">,
  from: MessageSender,
): TurnPeople {
  switch (from) {
    case "user":
      return { members: [input.author?.memberId ?? OWNER_MEMBER_ID], orchestrators: [] };
    case "member":
      return { members: [input.author?.memberId ?? UNKNOWN_MEMBER], orchestrators: [] };
    case "orchestrator": {
      const person = input.onBehalfOf ?? OWNER_MEMBER_ID;
      return { members: [person], orchestrators: [person] };
    }
    default:
      return AUTOMATIC;
  }
}

/** The people held-back orchestrator messages delivered with a turn speak for. */
function peopleOfNotices(notices: readonly Notice[]): TurnPeople {
  let people = AUTOMATIC;
  for (const n of notices) {
    if (n.type !== "orchestrator.message") continue;
    people = merge(people, peopleOf({ onBehalfOf: n.data.onBehalfOf }, "orchestrator"));
  }
  return people;
}

/** What the delivery of a role session's turn reports back (`TurnAuthority.begin`). */
export interface TurnStart {
  /** The turn carries these notices too (its held-back orchestrator messages count). */
  carry: (notices: readonly Notice[]) => void;
  /** `mayHaveStarted`: the runner may run the turn anyway (a timeout, a lost link). */
  failed: (mayHaveStarted: boolean) => void;
}

/**
 * The people each role session's current turn acts for, kept with its start metadata so a turn
 * that outlives a server restart keeps them. A turn's people are set when its first message is
 * handed to the runner (with the held-back orchestrator messages it carries) and grow with each
 * message that steers it. A delivery the runner refused puts back the turn that runs; one that may
 * have started anyway counts both, so a turn never acts with more than either.
 */
export class TurnAuthority {
  private readonly current = new Map<string, TurnPeople>();

  constructor(private readonly repo: Pick<SessionRepo, "find" | "setStartMeta">) {}

  /** The people the session's current turn acts for; automatic when none were recorded. */
  of(sessionId: string): TurnPeople {
    let people = this.current.get(sessionId);
    if (!people) {
      people = this.repo.find(sessionId)?.startMeta?.turnPeople ?? AUTOMATIC;
      this.current.set(sessionId, people);
    }
    return people;
  }

  /** A turn of a role session begins with `input` from `from`. */
  begin(
    session: Session,
    input: Pick<UserInput, "author" | "onBehalfOf">,
    from: MessageSender,
  ): TurnStart {
    if (session.role === "agent") return { carry: () => {}, failed: () => {} };
    const previous = this.of(session.id);
    let next = peopleOf(input, from);
    this.record(session.id, next);
    return {
      carry: (notices) => {
        const people = peopleOfNotices(notices);
        if (people.members.length === 0) return;
        next = merge(next, people);
        this.record(session.id, next);
      },
      failed: (mayHaveStarted) =>
        this.record(session.id, mayHaveStarted ? merge(previous, next) : previous),
    };
  }

  /** A message steered the session's running turn: the turn acts for its sender too. */
  steered(session: Session, input: Pick<UserInput, "author" | "onBehalfOf">, from: MessageSender) {
    if (session.role === "agent") return;
    this.record(session.id, merge(this.of(session.id), peopleOf(input, from)));
  }

  private record(sessionId: string, people: TurnPeople): void {
    this.current.set(sessionId, people);
    const stored = this.repo.find(sessionId)?.startMeta;
    if (!stored) return;
    this.repo.setStartMeta(sessionId, (meta) => ({ ...(meta ?? stored), turnPeople: people }));
  }
}
