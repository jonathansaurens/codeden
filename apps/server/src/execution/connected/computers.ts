import { randomBytes } from "node:crypto";
import {
  type ConnectCodeResponse,
  type ConnectCodeStatus,
  type CreateConnectCodeRequest,
  MACHINE_RUNNER_HOME,
  type Member,
  type PairRequest,
  type PairResponse,
  RunnerConnectClose,
  type RunnerRecord,
} from "@codeden/contracts";
import type { Db } from "../../db/client";
import { findRunnerRecord, listRunnerRecords } from "../../events/runner-projection";
import type { EventStore } from "../../events/store";
import type { Principal } from "../../members/principal";
import type { IncomingLinks, IncomingSink, IncomingSocket } from "../../runner/transport-incoming";
import { errorMessage, ServiceError } from "../../services/errors";
import { defaultLabel } from "../ssh/args";
import type { MachineHub, MachineService } from "../ssh/machines";
import { ConnectCredentials, type RedeemRefusal } from "./credentials";

export interface ComputerServiceDeps {
  db: Db;
  store: EventStore;
  hub: MachineHub;
  machines: MachineService;
  links: IncomingLinks;
  member: (id: string) => Member | undefined;
  /** Load the Fake provider in computers' runners (when the server has it on). */
  fake?: boolean;
  now?: () => number;
  log?: (message: string) => void;
}

/** Not reached through it: a connected computer's runner is reached only over its link. */
const LOCK_FILE = `${MACHINE_RUNNER_HOME}/runner/runner.json`;

const REFUSED: Record<RedeemRefusal, string> = {
  unknown: "That pairing code isn't valid. Get a new one in Settings › Machines",
  used: "That pairing code was already used. Get a new one in Settings › Machines",
  expired:
    "That pairing code has expired (codes last 10 minutes). Get a new one in Settings › Machines",
};

/**
 * People's own computers (`docs/machines-teams-and-agents.md` §D.5). A person asks for a pairing
 * code; `codeden connect` on their computer trades it for a device key, which makes the computer
 * a machine (backend `connected`) owned by them, and links its runner in over a WebSocket. The
 * server never dials it: its `RunnerClient` waits for the computer's next socket on every
 * (re)connect. Only its person may place work on it (`placementRefusal`), Automatic never
 * chooses it, and it is untrusted like any machine. Disconnecting it, or deleting its person,
 * revokes its key and ends its link.
 */
export class ComputerService {
  readonly credentials: ConnectCredentials;

  constructor(private readonly deps: ComputerServiceDeps) {
    this.credentials = new ConnectCredentials(deps.db, deps.now);
    deps.store.subscribe((events) => {
      for (const e of events) {
        if (e.type === "member.deleted") {
          void this.removeMemberComputers((e.payload as { memberId: string }).memberId);
        }
      }
    });
  }

  /**
   * A pairing code for the caller's own computer, with the command to run there. Any person may
   * ask (not a connected agent): what they may do with the computer is still their role's.
   */
  createCode(principal: Principal, req: CreateConnectCodeRequest): ConnectCodeResponse {
    const member = principal.member;
    if (member.kind !== "person" || member.disabled) {
      throw new ServiceError(403, "forbidden", "Only a person can connect their own computer");
    }
    const { id, code, expiresAt } = this.credentials.createCode(member.id);
    const command = `${this.deps.machines.command} connect ${req.serverUrl} --code ${code}`;
    return { id, code, expiresAt, command };
  }

  /** Where the caller's pairing code is: waiting, paired, connected, or expired. */
  codeStatus(principal: Principal, id: string): ConnectCodeStatus {
    const code = this.credentials.code(id, principal.member.id);
    if (!code) throw new ServiceError(404, "code_not_found", "No such pairing code");
    if (this.credentials.expired(code)) return { state: "expired", machineId: null };
    if (!code.machineId) return { state: "waiting", machineId: null };
    const record = this.deps.machines.records().find((r) => r.id === code.machineId);
    const state = record?.state === "connected" ? "connected" : "paired";
    return { state, machineId: code.machineId };
  }

  /**
   * Trade a pairing code for a device key (public: the code is the credential; failures are
   * throttled by the caller). Makes the computer's machine record, or keeps the one it was
   * paired as before when that is the same person's (`previousMachineId`), and starts waiting
   * for its link. A code that is unknown, used or expired is refused (401 to the computer).
   */
  pair(req: PairRequest): PairResponse | { refused: { code: string; message: string } } {
    const redeemed = this.credentials.redeem(req.code);
    if ("refused" in redeemed) {
      const why = redeemed.refused;
      return { refused: { code: `code_${why}`, message: REFUSED[why] } };
    }
    const member = this.deps.member(redeemed.memberId);
    if (!member || member.disabled || member.kind !== "person") {
      return { refused: { code: "code_unknown", message: REFUSED.unknown } };
    }
    const previous = req.previousMachineId
      ? findRunnerRecord(this.deps.db, req.previousMachineId)
      : undefined;
    const same =
      previous?.backend === "connected" && previous.ownerMemberId === member.id
        ? previous
        : undefined;
    const id = same?.id ?? `c-${randomBytes(4).toString("hex")}`;
    const label = this.labelFor(same, req.hostname || "computer", id);
    // Paired again while it is still a machine: same record, new key, the link replaced.
    if (!this.deps.hub.client(id))
      this.addRunner({ id, label, hostname: req.hostname, owner: member.id });
    const key = this.credentials.createKey(member.id, id);
    this.credentials.attachCode(redeemed.codeId, id);
    this.deps.links.drop(id, RunnerConnectClose.replaced, "the computer was paired again");
    this.deps.log?.(`machines: ${member.name} paired ${label}`);
    return { machineId: id, label, key, fake: this.deps.fake === true };
  }

  /**
   * The machine a device key links, or undefined: unknown and revoked keys, and keys of a
   * computer that was removed, link nothing.
   */
  authenticate(key: string | undefined): string | undefined {
    const verified = this.credentials.verifyKey(key);
    if (!verified) return undefined;
    const record = findRunnerRecord(this.deps.db, verified.machineId);
    if (record?.backend !== "connected" || record.state === "deleted") return undefined;
    if (!this.deps.hub.client(record.id)) return undefined;
    return record.id;
  }

  /** An authenticated socket from a computer: its runner's next link. */
  arrive(machineId: string, socket: IncomingSocket): IncomingSink {
    return this.deps.links.arrive(machineId, socket);
  }

  /**
   * Disconnect a computer (its person, or an Owner): removed like any machine (refused while
   * sessions are placed there, or a clone holds unpushed work, unless `force`), its key revoked
   * and its link ended, so `codeden connect` on it stops.
   */
  async disconnect(
    principal: Principal,
    idOrLabel: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const record = this.deps.machines.require(idOrLabel);
    if (record.backend !== "connected") {
      throw new ServiceError(
        400,
        "machine_not_connected",
        "Only a connected computer is disconnected; remove a machine over SSH instead",
      );
    }
    const member = principal.member;
    const ownerOfServer = member.role === "owner" && !member.disabled && member.kind === "person";
    if (member.id !== record.ownerMemberId && !ownerOfServer) {
      throw new ServiceError(
        403,
        "forbidden",
        "Only its person or an Owner can disconnect this computer",
      );
    }
    await this.deps.machines.remove(record.id, opts);
    this.forget(record);
  }

  /** A deleted member's computers: removed whatever runs there, their keys revoked. */
  async removeMemberComputers(memberId: string): Promise<void> {
    this.credentials.revokeMemberCodes(memberId);
    for (const record of this.records()) {
      if (record.ownerMemberId !== memberId) continue;
      try {
        await this.deps.hub.remove(record.id, { deleted: true });
      } catch (error) {
        this.deps.log?.(`machines: removing ${record.label}: ${errorMessage(error)}`);
      }
      this.forget(record);
    }
  }

  /** After a server restart: wait again for every connected computer to link in. */
  reattach(): void {
    for (const record of this.records()) {
      if (this.deps.hub.client(record.id)) continue;
      this.addRunner({
        id: record.id,
        label: record.label ?? record.id,
        hostname: record.sandboxRef ?? "",
        owner: record.ownerMemberId,
      });
    }
  }

  private records(): RunnerRecord[] {
    return listRunnerRecords(this.deps.db).filter(
      (r) => r.backend === "connected" && r.state !== "deleted",
    );
  }

  private forget(record: RunnerRecord): void {
    this.credentials.revokeMachine(record.id);
    this.deps.links.drop(record.id, RunnerConnectClose.revoked, "this computer was disconnected");
    this.deps.log?.(`machines: disconnected ${record.label ?? record.id}`);
  }

  private addRunner(m: { id: string; label: string; hostname: string; owner: string | null }) {
    const client = this.deps.hub.add({
      id: m.id,
      backend: "connected",
      link: this.deps.links.link(m.id),
      dir: MACHINE_RUNNER_HOME,
      lockFile: LOCK_FILE,
      launch: null,
      sandboxRef: m.hostname.slice(0, 255) || null,
      label: m.label,
      ownerMemberId: m.owner,
      // A runner of another version drains and exits; `codeden connect` starts it again.
      replaceOnMismatch: true,
    });
    // Resolves once the computer first links in, whenever that is.
    client
      .start()
      .catch((error: unknown) => this.deps.log?.(`machines: ${m.label}: ${errorMessage(error)}`));
  }

  /** The machine's label: its old one when free, else one from the host name, unique. */
  private labelFor(previous: RunnerRecord | undefined, hostname: string, id: string): string {
    const taken = new Set(
      this.deps.machines
        .records()
        .filter((r) => r.id !== id)
        .map((r) => (r.label ?? r.id).toLowerCase()),
    );
    if (previous?.label && !taken.has(previous.label.toLowerCase())) return previous.label;
    const base = defaultLabel(hostname).slice(0, 36);
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const label = `${base}-${n}`;
      if (!taken.has(label.toLowerCase())) return label;
    }
  }
}
