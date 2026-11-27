import { AsyncLocalStorage } from "node:async_hooks";
import type { Actor, Member } from "@codeden/contracts";
import type { Context } from "hono";

/**
 * Who is making a request (§B.2): the install token (this machine's browser and the desktop
 * window, acting as the first owner), a signed-in device, or a connected agent's token.
 */
export interface Principal {
  member: Member;
  via: "install" | "session" | "token";
  /** The remote session (device) id, for `via: "session"`. */
  sessionId?: string;
  /** The token's id, for `via: "token"`. */
  tokenId?: string;
}

interface PrincipalVariables {
  principal?: Principal;
}

/** The request's principal, set by the security middleware; undefined on public paths. */
export function principalOf(c: Context): Principal | undefined {
  return (c as Context<{ Variables: PrincipalVariables }>).get("principal");
}

export function setPrincipal(c: Context, principal: Principal): void {
  (c as Context<{ Variables: PrincipalVariables }>).set("principal", principal);
}

export function actorOf(principal: Principal): Actor {
  return { memberId: principal.member.id, kind: principal.member.kind };
}

const current = new AsyncLocalStorage<Principal>();

/**
 * Run `fn` on behalf of `principal`: events appended inside it carry the principal as their
 * actor (§B.4), and services can tell a person from a connected agent.
 */
export function runAs<T>(principal: Principal, fn: () => T): T {
  return current.run(principal, fn);
}

/** The principal the current request runs as, if any (background work has none). */
export function currentPrincipal(): Principal | undefined {
  return current.getStore();
}

/** The current actor, if a person or agent caused the work in progress. */
export function currentActor(): Actor | undefined {
  const principal = current.getStore();
  return principal ? actorOf(principal) : undefined;
}
