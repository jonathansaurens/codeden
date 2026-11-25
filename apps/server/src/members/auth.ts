import { type Member, OWNER_MEMBER_ID, type RemoteDevice } from "@codeden/contracts";
import type { NetworkAccess } from "../network/access";
import type { PrincipalHooks } from "../security";
import type { Principal } from "./principal";
import type { MemberService } from "./service";

export interface MemberAuthOptions {
  members: MemberService;
  network: NetworkAccess;
}

/**
 * How requests become members (§B.2, §C.1): the install token is the first owner, a device's
 * session is the member who signed in on it, and a connected agent's bearer token is that agent.
 * Disabled and deleted members are refused everywhere.
 */
export class MemberAuth {
  readonly members: MemberService;
  private readonly network: NetworkAccess;

  constructor(opts: MemberAuthOptions) {
    this.members = opts.members;
    this.network = opts.network;
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
      // Connected agents' tokens come with agent members.
      claims: () => false,
      bearer: () => ({ refused: 401, message: "Missing or invalid token" }),
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

  /** A member's signed-in devices. */
  devices(memberId: string, currentSessionId: string | null): RemoteDevice[] {
    return this.network
      .status({ remote: false, sessionId: currentSessionId })
      .devices.filter((d) => d.memberId === memberId);
  }

  /** Sign out a member's devices and close remote connections (it was disabled or deleted). */
  cutOff(memberId: string): void {
    this.network.store.revokeMember(memberId);
    this.network.dropRemote();
  }
}
