import {
  ROLE_ON_SERVER,
  type RoleRunsOn,
  type RunnerRecord,
  type RunsOnChoice,
  type Session,
} from "@codeden/contracts";
import type { MachineService } from "../../execution/ssh/machines";
import type { MemberPreferences } from "../../members/preferences";
import { errorMessage, ServiceError } from "../errors";
import { projectDefaultProvider } from "../projects/project-config";
import type { ProjectService } from "../projects/project-service";
import type { RunnerPort } from "../runner-port";
import type { MachinePlacement } from "../sessions/placement";
import { autoOrder } from "../sessions/provider-order";
import type { SessionService } from "../sessions/session-service";
import { memberOfKey } from "./role-keys";

/**
 * Where a role's next session runs now (`docs/machines-teams-and-agents.md` §D.4):
 * - `machine`: its chosen machine, which can take it (connected, the provider ready there);
 * - `server`: chosen, or the chosen machine can't take it and the server does (`fallback`);
 * - `nowhere`: the chosen machine can't take it and neither can the server.
 */
export type RoleTarget =
  | { kind: "machine"; placement: MachinePlacement; provider: string }
  | { kind: "server"; fallback?: { machineId: string; reason: string } }
  | { kind: "nowhere"; machineId: string; reason: string };

/** The device id a target names: `server`, or the machine's id. */
export function targetDevice(target: RoleTarget): RoleRunsOn {
  if (target.kind === "machine") return target.placement.record.id;
  return target.kind === "nowhere" ? target.machineId : ROLE_ON_SERVER;
}

export type RoleMachines = Pick<
  MachineService,
  "records" | "port" | "providerReady" | "roleRefusal" | "computerName" | "view"
>;

export interface RolePlacementDeps {
  machines?: RoleMachines;
  projects: Pick<ProjectService, "get">;
  preferences: Pick<MemberPreferences, "orchestratorRunsOn">;
  sessions: Pick<SessionService, "configuredProvider">;
  /** The home runner: the server's own. */
  runner: Pick<RunnerPort, "isConnected">;
  /** The `runners` record a journal id belongs to (any state), for a session's device. */
  recordOfRunner: (runnerId: string) => RunnerRecord | undefined;
  log?: (message: string) => void;
}

type Role = "orchestrator" | "pm";

/** A role's move to another device, told in its new chat (`RoleSessions.onMoved`). */
export interface PlacementMove {
  reason: "moved" | "fallback" | "back";
  from: string;
  to: string;
  message: string;
}

/** Neither the role's machine nor the server can take its turn now: why, for its chat. */
export interface PlacementWait {
  machineId: string;
  message: string;
}

/**
 * Roles whose machine and the server both can't take a turn now (§D.4), by role key, each with
 * one retry of its devices after a while (30 s), so a message that waits moves to whichever
 * comes back first.
 */
export class RoleWaits {
  private readonly waiting = new Map<string, PlacementWait>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly retryMs = 30_000) {}

  get(key: string): PlacementWait | undefined {
    return this.waiting.get(key);
  }

  wait(key: string, why: PlacementWait, retry: () => unknown): void {
    this.waiting.set(key, why);
    if (this.timers.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      retry();
    }, this.retryMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  stop(key: string): void {
    this.waiting.delete(key);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }
}

/**
 * "Runs on" for the orchestrator and the PMs (§D.4): the setting (a person's for their
 * orchestrator, the project's for its PM), whether the chosen machine can take the role's next
 * turn, and which device a role session runs on. Never chooses a machine by itself.
 */
export class RolePlacement {
  /**
   * Roles whose session couldn't be started on their machine (§D.4), by role: the role's next
   * session starts on the server instead, once, and the machine is tried again after that.
   */
  private readonly startFailures = new Map<string, { machineId: string; reason: string }>();

  constructor(private readonly deps: RolePlacementDeps) {}

  /** The role's session failed to start on `machineId`: its next one runs on the server. */
  startFailed(role: Role, of: string | null, machineId: string, reason: string): void {
    this.startFailures.set(`${role}:${of}`, { machineId, reason });
  }

  /** A session of the role started: a start failure it stood in for is behind it. */
  started(role: Role, of: string | null): void {
    this.startFailures.delete(`${role}:${of}`);
  }

  /** The role's setting: `server` or a machine id. `of` is the PM's project or a person key. */
  setting(role: Role, of: string | null): RoleRunsOn {
    if (role === "pm") return of ? this.deps.projects.get(of).pmRunsOn : ROLE_ON_SERVER;
    return this.deps.preferences.orchestratorRunsOn(memberOfKey(of));
  }

  /** The device a role session runs on: `server` (Home), or the machine record's id. */
  deviceOf(session: Pick<Session, "runnerId">): RoleRunsOn {
    if (!session.runnerId) return ROLE_ON_SERVER;
    const record = this.deps.recordOfRunner(session.runnerId);
    return !record || record.home ? ROLE_ON_SERVER : record.id;
  }

  /** "the server", or the machine's name ("vps-1", "Alice's computer (mbp)"). */
  label(device: RoleRunsOn): string {
    if (device === ROLE_ON_SERVER) return "the server";
    const record = this.record(device) ?? this.deps.recordOfRunner(device);
    if (!record) return "a removed machine";
    return this.deps.machines?.computerName(record) ?? record.label ?? record.id;
  }

  private record(id: string): RunnerRecord | undefined {
    return this.deps.machines?.records().find((r) => r.id === id);
  }

  /** Where the role's next session runs now, as its setting and the devices allow. */
  async target(role: Role, of: string | null): Promise<RoleTarget> {
    const want = this.setting(role, of);
    if (want === ROLE_ON_SERVER) return { kind: "server" };
    const failed = this.startFailures.get(`${role}:${of}`);
    if (failed?.machineId === want && this.deps.runner.isConnected()) {
      return { kind: "server", fallback: failed };
    }
    const why = await this.machineProblem(role, of, want);
    if (typeof why !== "string") return why;
    if (this.deps.runner.isConnected()) {
      return { kind: "server", fallback: { machineId: want, reason: why } };
    }
    return { kind: "nowhere", machineId: want, reason: why };
  }

  /**
   * The chosen machine with the provider a role session starts on there, or why it can't take
   * the role now: removed, not this person's to use, offline, the project not on GitHub, or no
   * provider ready there (the role's provider setting, else any that runs read-only).
   */
  private async machineProblem(
    role: Role,
    of: string | null,
    id: string,
  ): Promise<RoleTarget | string> {
    const record = this.record(id);
    if (!record) return "The machine chosen for it was removed";
    const name = this.label(id);
    const project = role === "pm" && of ? this.deps.projects.get(of) : null;
    const refused = this.deps.machines?.roleRefusal(
      record,
      project?.id ?? null,
      role === "orchestrator" ? memberOfKey(of) : null,
    );
    if (refused) return refused;
    if (role === "pm" && project?.kind !== "github") {
      return `${name} can't run the PM: the project isn't on GitHub`;
    }
    const port = this.deps.machines?.port(record);
    if (!port?.isConnected() || !record.runnerId) return `${name} is offline`;
    try {
      const provider = await this.providerOn(role, project, record, port);
      if (typeof provider !== "string") return provider.problem;
      return { kind: "machine", placement: { record, port }, provider };
    } catch (error) {
      this.deps.log?.(`role placement: ${name}: ${errorMessage(error)}`);
      return `${name} didn't say which providers it has`;
    }
  }

  private async providerOn(
    role: Role,
    project: ReturnType<ProjectService["get"]> | null,
    record: RunnerRecord,
    port: RunnerPort,
  ): Promise<string | { problem: string }> {
    const machines = this.deps.machines as RoleMachines;
    const name = this.label(record.id);
    const wanted = this.deps.sessions.configuredProvider(
      role,
      project ? projectDefaultProvider(project) : null,
      port,
    );
    if (wanted) {
      const found = await machines.providerReady(record, wanted);
      if (found?.ready) return wanted;
      const what = found?.name ?? wanted;
      return { problem: `${what} isn't ready on ${name}: ${found?.reason ?? "not installed"}` };
    }
    const loaded = port.providers().filter((p) => p.capabilities.readOnly);
    for (const id of autoOrder(loaded.map((p) => p.id))) {
      if ((await machines.providerReady(record, id))?.ready) return id;
    }
    return { problem: `No provider is signed in on ${name}` };
  }

  /**
   * How a replacement moved the role to another device (§D.4), told in its new chat, or
   * undefined when it stayed. `fellBackFrom`: the machine the old session stood in for.
   */
  move(
    from: Pick<Session, "runnerId">,
    to: Pick<Session, "runnerId">,
    target: RoleTarget,
    fellBackFrom: string | undefined,
  ): PlacementMove | undefined {
    const was = this.deviceOf(from);
    const now = this.deviceOf(to);
    if (was === now) return undefined;
    const label = this.label(now);
    if (target.kind === "server" && target.fallback) {
      const away = this.label(target.fallback.machineId);
      const message = `${target.fallback.reason}; this turn runs on the server, until ${away} can take it again.`;
      return { reason: "fallback", from: was, to: now, message };
    }
    if (fellBackFrom === now)
      return { reason: "back", from: was, to: now, message: `Back on ${label}.` };
    return { reason: "moved", from: was, to: now, message: `Moved to ${label}.` };
  }

  /**
   * The choices a person may pick for a role (`RunsOnChoice`): the server, then every machine
   * they may use (someone else's own computer is left out), each with whether it can take the
   * role now. `person` is who chooses: the orchestrator's person, or the Owner setting a PM's.
   */
  async choices(role: Role, of: string | null, person: string): Promise<RunsOnChoice[]> {
    const server: RunsOnChoice = {
      id: ROLE_ON_SERVER,
      label: "The server",
      state: this.deps.runner.isConnected() ? "connected" : "disconnected",
      ready: this.deps.runner.isConnected(),
      reason: this.deps.runner.isConnected() ? null : "The server's runner is restarting",
      owner: null,
    };
    const project = role === "pm" && of ? this.deps.projects.get(of) : null;
    const machines = this.deps.machines?.records() ?? [];
    const mine = machines.filter((r) => !r.ownerMemberId || r.ownerMemberId === person);
    const listed = await Promise.all(
      mine.map(async (record): Promise<RunsOnChoice | null> => {
        // A PM may go to its Owner's own computer only (§D.4).
        if (this.deps.machines?.roleRefusal(record, project?.id ?? null, person)) return null;
        const problem = await this.machineProblem(role, of, record.id);
        return {
          id: record.id,
          label: this.label(record.id),
          state: record.state,
          ready: typeof problem !== "string",
          reason: typeof problem === "string" ? problem : null,
          owner: this.deps.machines?.view(record).owner ?? null,
        };
      }),
    );
    return [server, ...listed.filter((c): c is RunsOnChoice => c !== null)];
  }

  /**
   * Why `person` may not choose `runsOn` for the role, or null when they may: it must be the
   * server or a machine that exists and that they may use; a PM needs a GitHub project.
   */
  refusal(
    role: Role,
    projectId: string | null,
    person: string,
    runsOn: RoleRunsOn,
  ): ServiceError | null {
    if (runsOn === ROLE_ON_SERVER) return null;
    const record = this.record(runsOn);
    if (!record) return new ServiceError(400, "unknown_machine", `No machine ${runsOn}`);
    const refused =
      record.ownerMemberId && record.ownerMemberId !== person
        ? `${this.label(runsOn)} is someone else's own computer`
        : this.deps.machines?.roleRefusal(record, projectId, person);
    if (refused) return new ServiceError(403, "machine_not_yours", refused);
    if (role === "pm" && projectId && this.deps.projects.get(projectId).kind !== "github") {
      return new ServiceError(
        400,
        "machine_unavailable",
        "A project that isn't on GitHub keeps its PM on the server: machines clone it from GitHub",
      );
    }
    return null;
  }
}
