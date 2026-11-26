import {
  AGENT_TOKEN_PREFIX,
  type Member,
  OWNER_MEMBER_ID,
  type RemoteDevice,
} from "@codeden/contracts";
import type { Context } from "hono";
import type { NetworkAccess } from "../network/access";
import { SignInLimiter } from "../network/rate-limit";
import { type BearerCheck, type PrincipalHooks, peerAddress, proxyClientOf } from "../security";
import type { Principal } from "./principal";
import { AgentRateLimiter } from "./rate-limit";
import type { MemberService } from "./service";

export interface MemberAuthOptions {
  members: MemberService;
  network: NetworkAccess;
  now?: () => number;
  /** Per-token limits (tests pass a small one). */
  rate?: AgentRateLimiter;
}

/**
 * How requests become members (§B.2, §C.1): the install token is the first owner, a device's
 * session is the member who signed in on it, and a connected agent's bearer token is that agent.
 * Disabled and deleted members are refused everywhere. Failed tokens are throttled per address
 * with the sign-in rules (§15.1); good tokens have a rate limit of their own (§C.3).
 */
export class MemberAuth {
  readonly members: MemberService;
  private readonly network: NetworkAccess;
  /** Failed agent tokens, per client address (the sign-in rules). */
  readonly tokenFailures: SignInLimiter;
  readonly rate: AgentRateLimiter;

  constructor(opts: MemberAuthOptions) {
    this.members = opts.members;
    this.network = opts.network;
    this.tokenFailures = new SignInLimiter(opts.now);
    this.rate = opts.rate ?? new AgentRateLimiter(opts.now);
  }

  ownerPrincipal(): Principal {
    return { member: this.members.owner(), via: "install" };
  }

  hooks(): PrincipalHooks {
    return {
      install: () => this.ownerPrincipal(),
      session: (session) => {
        const member = this.members.find(session.memberId ?? OWNER_MEMBER_ID);
        if (!member || member.disabled || member.kind !== "person") return undefined;
        return { member, via: "session", sessionId: session.id };
      },
      claims: (token) => token.startsWith(AGENT_TOKEN_PREFIX),
      bearer: (token, c) => this.checkBearer(token, c),
    };
  }

  /**
   * Sign a person in: with a name, that member's passphrase; without one (or with the first
   * owner's name), the network password, as before members existed.
   */
  async signIn(name: string | undefined, password: string): Promise<Member | undefined> {
    const owner = this.members.owner();
    const wanted = name?.trim();
    if (!wanted || wanted.toLowerCase() === owner.name.toLowerCase()) {
      return (await this.network.store.checkPassword(password)) ? owner : undefined;
    }
    const member = this.members.findPersonByName(wanted);
    // An unknown name costs the same as a wrong passphrase, so names can't be probed by timing.
    const ok = await this.members.checkPassphrase(member?.id ?? "", password);
    if (!member || !ok || member.disabled) return undefined;
    return member;
  }

  /**
   * Who a sign-in with `name` tries to be, for the sign-in throttle: the member's id, or the
   * name itself when nobody has it (failures for it still count, and nothing clears them).
   */
  signInTarget(name: string | undefined): string {
    const owner = this.members.owner();
    const wanted = name?.trim();
    if (!wanted || wanted.toLowerCase() === owner.name.toLowerCase()) return owner.id;
    return this.members.findPersonByName(wanted)?.id ?? `name:${wanted.toLowerCase()}`;
  }

  /** A member's signed-in devices. */
  devices(memberId: string, currentSessionId: string | null): RemoteDevice[] {
    return this.network
      .status({ remote: false, sessionId: currentSessionId })
      .devices.filter((d) => d.memberId === memberId);
  }

  /**
   * Sign out a member's devices and close its connections, on any address (it is being deleted).
   * Other members' connections stay open, and so does `except`: the request asking for it.
   */
  cutOff(memberId: string, except?: object): void {
    this.network.store.revokeMember(memberId);
    this.network.dropConnections({ memberId }, except);
  }

  private checkBearer(token: string, c: Context): BearerCheck {
    const proxy = proxyClientOf(c);
    const address = proxy ? `proxy:${proxy.address ?? "unknown"}` : peerAddress(c);
    const gate = this.tokenFailures.check(address);
    if (!gate.allowed) {
      return {
        refused: 429,
        retryAfterSec: Math.ceil(gate.retryAfterMs / 1000),
        message: "Too many bad tokens from this address. Wait and try again.",
      };
    }
    const verified = this.members.verifyToken(token);
    if (!verified) {
      this.tokenFailures.fail(address);
      this.network.recordFailedSignIn(address, "invalid agent token", proxy !== undefined);
      return { refused: 401, message: "Missing or invalid CodeDen agent token" };
    }
    // A good token clears nothing: bad ones are guesses at other tokens, and only age out.
    const rate = this.rate.take(verified.tokenId);
    if (!rate.allowed) {
      return {
        refused: 429,
        retryAfterSec: Math.ceil(rate.retryAfterMs / 1000),
        message: "This agent is sending requests too fast. Slow down.",
      };
    }
    return { principal: { member: verified.member, via: "token", tokenId: verified.tokenId } };
  }
}
