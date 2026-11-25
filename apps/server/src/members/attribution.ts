import type { Actor, UserInput } from "@codeden/contracts";
import { forbidden } from "../services/errors";
import { currentActor, currentPrincipal } from "./principal";

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

/**
 * Connected agents answer approvals only when an owner ticked "May answer approvals" for them
 * (§C.3); questions are always theirs to answer. Throws 403 otherwise.
 */
export function assertMayAnswerApproval(): void {
  const member = currentPrincipal()?.member;
  if (member?.kind === "agent" && !member.mayAnswerApprovals) {
    throw forbidden(
      "This connected agent may not answer approvals. An owner can allow it in Settings › Members.",
      "approvals_not_allowed",
    );
  }
}
