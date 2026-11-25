import type { Actor, UserInput } from "@codeden/contracts";
import { currentActor } from "./principal";

/**
 * A message's input with its author (§B.4): the member whose request sends it, when a person or
 * connected agent wrote it (`from: "user"`). An `author` the client sent is never kept.
 */
export function withAuthor(input: UserInput, from: string): UserInput {
  const { author: _claimed, ...rest } = input;
  const actor = from === "user" ? currentActor() : undefined;
  return actor ? { ...rest, author: actor } : rest;
}

/** The current member as a resolution field (`answeredBy`), or nothing for CodeDen's own work. */
export function answeredBy(): { answeredBy: Actor } | Record<string, never> {
  const actor = currentActor();
  return actor ? { answeredBy: actor } : {};
}

/** The member who answered an inbox item first, from its resolution. */
export function answeredByOf(resolution: unknown): Actor | undefined {
  if (!resolution || typeof resolution !== "object") return undefined;
  const by = (resolution as { answeredBy?: unknown }).answeredBy;
  if (!by || typeof by !== "object") return undefined;
  const { memberId, kind } = by as { memberId?: unknown; kind?: unknown };
  return typeof memberId === "string" && (kind === "person" || kind === "agent")
    ? { memberId, kind }
    : undefined;
}
