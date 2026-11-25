import { randomBytes } from "node:crypto";
import {
  type AddMachineRequest,
  CODEDEN_VERSION,
  DEFAULT_MACHINE_WEIGHT,
  describeUnpushedWork,
  hasUnpushedWork,
  MACHINE_RUNNER_HOME,
  type Machine,
  type MachineProvider,
  MachineWeight,
  type ProviderStatus,
  type RunnerRecord,
} from "@codeden/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { sessions } from "../../db/schema";
import { listRunnerRecords } from "../../events/runner-projection";
import type { RunnerHub } from "../../runner/hub";
import { type ExecLinkConfig, execLink } from "../../runner/transport-exec";
import { errorMessage, ServiceError } from "../../services/errors";
import { type Exec, resolveExecutable, runTool } from "../../services/exec";
import type { RunnerPort } from "../../services/runner-port";
import { runnerErrorCode } from "../../services/runner-port";
import {
  checkCodeden,
  checkNode,
  codedenVersionCommand,
  defaultLabel,
  linkCommand,
  nodeVersionCommand,
  pinnedCommand,
  sshArgs,
} from "./args";
import { providerReadiness } from "./readiness";

/** What machines need of the runner hub. */
export type MachineHub = Pick<
  RunnerHub,
  "add" | "remove" | "client" | "forRunnerId" | "list" | "setWeight"
>;

export interface MachineServiceDeps {
  db: Db;
  hub: MachineHub;
  /** Runs `ssh` for the checks (tests script it). */
  exec?: Exec;
  /** The `ssh` command (default `ssh` on PATH); tests point it at a shim. */
  sshCommand?: string;
  /**
   * The command prefix machines run CodeDen with. Default `npx -y codeden@<version>`; the
   * owner's development override (`CODEDEN_MACHINE_COMMAND`) replaces it.
   */
  command?: string;
  /** The version machines must run (default this build's). */
  version?: string;
  /** Load the Fake provider in machines' runners (when the server has it on). */
  fake?: boolean;
  /** How long a new machine's runner may take to answer (default 2 minutes). */
  connectTimeoutMs?: number;
  log?: (message: string) => void;
}

/** A machine's runner home, and its lock file there: reached only through the link. */
const LOCK_FILE = `${MACHINE_RUNNER_HOME}/runner/runner.json`;
const NODE_CHECK_MS = 30_000;
/** The first `npx -y codeden@<v>` downloads the package. */
const CODEDEN_CHECK_MS = 5 * 60_000;
const DETECT_MS = 30_000;
/** How long a machine's provider report is reused. */
const PROVIDERS_TTL_MS = 60_000;
const UNPUSHED_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Machines over SSH (`docs/machines-teams-and-agents.md` Part A): other computers reached with
 * the user's own `ssh`, each running one long-lived runner in `~/.codeden-runner` that serves
 * every session placed on it. The server reaches it only through an exec link (`ssh <dest>
 * codeden runner-link`), which starts the runner first when it isn't running. A machine's
 * runner is untrusted, like a sandbox's, and its agents use the machine's own provider logins.
 */
export class MachineService {
  /** Settles once the machines from before a server restart are linked again (`reattach`). */
  reattached: Promise<void> = Promise.resolve();
  private readonly exec: Exec;
  private readonly version: string;
  private readonly statuses = new Map<string, { at: number; list: ProviderStatus[] }>();

  constructor(private readonly deps: MachineServiceDeps) {
    this.exec = deps.exec ?? runTool;
    this.version = deps.version ?? CODEDEN_VERSION;
  }

  /** The command prefix machines run CodeDen with (shown in Settings › Machines). */
  get command(): string {
    return this.deps.command?.trim() || pinnedCommand(this.version);
  }

  private get ssh(): string {
    return this.deps.sshCommand ?? "ssh";
  }

  /** Every machine record that wasn't removed. */
  records(): RunnerRecord[] {
    return this.deps.hub.list().filter((r) => r.backend === "ssh" && r.state !== "deleted");
  }

  /** A machine by record id or label (case-insensitive); undefined when there is none. */
  find(idOrLabel: string): RunnerRecord | undefined {
    const key = idOrLabel.toLowerCase();
    return this.records().find((r) => r.id === idOrLabel || r.label?.toLowerCase() === key);
  }

  /** Every machine with what its runner last reported. */
  async list(): Promise<Machine[]> {
    const records = this.records();
    await Promise.all(records.map((r) => this.refreshProviders(r)));
    return records.map((r) => this.view(r));
  }

  /** One machine as the API shows it. */
  view(record: RunnerRecord): Machine {
    const client = this.deps.hub.client(record.id);
    const loaded = client?.status.state === "connected" ? client.status.providers : [];
    const statuses = this.statuses.get(record.id)?.list ?? [];
    const providers: MachineProvider[] = loaded.map((p) => {
      const ready = providerReadiness(statuses.find((s) => s.providerId === p.id));
      return { id: p.id, name: p.displayName, ...ready };
    });
    const weight = MachineWeight.safeParse(record.weight);
    return {
      id: record.id,
      label: record.label ?? record.id,
      destination: record.sandboxRef ?? "",
      weight: weight.success ? weight.data : DEFAULT_MACHINE_WEIGHT,
      state: record.state,
      version: record.version,
      platform: client?.hostInfo?.platform ?? null,
      arch: client?.hostInfo?.arch ?? null,
      lastError: record.lastError,
      lastSeenAt: record.lastSeenAt,
      sessions: this.sessionsOn(record).filter((s) => !s.archivedAt).length,
      providers,
    };
  }

  /** The machine's provider statuses, asked again when older than a minute. */
  private async refreshProviders(record: RunnerRecord, force = false): Promise<void> {
    const cached = this.statuses.get(record.id);
    if (!force && cached && Date.now() - cached.at < PROVIDERS_TTL_MS) return;
    const port = record.runnerId ? this.deps.hub.forRunnerId(record.runnerId) : undefined;
    if (!port?.isConnected()) return;
    try {
      const result = await port.request(
        { name: "provider.detect", refreshModels: false },
        DETECT_MS,
      );
      this.statuses.set(record.id, { at: Date.now(), list: result.statuses });
    } catch (error) {
      this.deps.log?.(`machines: ${record.label}: provider check failed: ${errorMessage(error)}`);
    }
  }

  /** Whether `provider` can run new sessions on the machine, and why not. */
  async providerReady(record: RunnerRecord, provider: string): Promise<MachineProvider | null> {
    await this.refreshProviders(record);
    return this.view(record).providers.find((p) => p.id === provider) ?? null;
  }

  /** The machine's runner, for routing and commands. */
  port(record: RunnerRecord): RunnerPort | undefined {
    return record.runnerId ? this.deps.hub.forRunnerId(record.runnerId) : undefined;
  }

  /**
   * Check a machine and add it: `ssh` must sign in without prompting, Node.js must be 24 or
   * newer, the pinned CodeDen must run, and the machine's runner must start and answer. Each
   * failure says what to fix; nothing is saved unless all of it passes.
   */
  async add(req: AddMachineRequest): Promise<Machine> {
    const destination = req.destination;
    const label = req.name ?? defaultLabel(destination);
    const existing = this.records();
    if (existing.some((r) => r.label?.toLowerCase() === label.toLowerCase())) {
      throw new ServiceError(409, "name_taken", `A machine is already called ${label}`);
    }
    const same = existing.find((r) => r.sandboxRef === destination);
    if (same) {
      throw new ServiceError(
        409,
        "already_added",
        `${destination} is already added as ${same.label}`,
      );
    }
    const node = await this.run(destination, nodeVersionCommand(), NODE_CHECK_MS);
    const nodeFailure = checkNode(node, destination, label);
    if (nodeFailure) throw new ServiceError(400, nodeFailure.code, nodeFailure.message);
    const codeden = await this.run(
      destination,
      codedenVersionCommand(this.command),
      CODEDEN_CHECK_MS,
    );
    const codedenFailure = checkCodeden(codeden, destination, label, this.version, this.command);
    if (codedenFailure) throw new ServiceError(400, codedenFailure.code, codedenFailure.message);

    const id = `m-${randomBytes(4).toString("hex")}`;
    const client = this.addRunner({ id, destination, label, weight: null });
    const ms = this.deps.connectTimeoutMs ?? 120_000;
    try {
      await withTimeout(
        client.start(),
        ms,
        `The runner on ${label} did not answer within ${Math.round(ms / 1000)} s`,
      );
    } catch (error) {
      const why = client.status.lastError ?? errorMessage(error);
      await this.deps.hub.remove(id, { deleted: true }).catch(() => undefined);
      throw new ServiceError(502, "runner_failed", `The runner on ${label} didn't start: ${why}`);
    }
    this.deps.log?.(`machines: added ${label} (${destination})`);
    const record = this.find(id) as RunnerRecord;
    await this.refreshProviders(record, true);
    return this.view(record);
  }

  /** Run one command on a machine over `ssh`. */
  private run(destination: string, remote: string, timeoutMs: number) {
    return this.exec(this.ssh, sshArgs(destination, remote), { timeoutMs });
  }

  /** The link to a machine's runner: each (re)connect runs a new `ssh`. */
  link(destination: string): ExecLinkConfig {
    const command = resolveExecutable(this.ssh) ?? this.ssh;
    return execLink(
      command,
      sshArgs(destination, linkCommand(this.command, { fake: this.deps.fake })),
    );
  }

  private addRunner(m: { id: string; destination: string; label: string; weight: number | null }) {
    return this.deps.hub.add({
      id: m.id,
      backend: "ssh",
      link: this.link(m.destination),
      dir: MACHINE_RUNNER_HOME,
      lockFile: LOCK_FILE,
      launch: null,
      sandboxRef: m.destination,
      label: m.label,
      weight: m.weight,
      // A runner of another version drains and exits; the next link starts the current one.
      replaceOnMismatch: true,
    });
  }

  /** Change a machine's preference for automatic placement. */
  setWeight(idOrLabel: string, weight: MachineWeight): Machine {
    const record = this.require(idOrLabel);
    return this.view(this.deps.hub.setWeight(record.id, weight));
  }

  private require(idOrLabel: string): RunnerRecord {
    const record = this.find(idOrLabel);
    if (!record) throw new ServiceError(404, "machine_not_found", `No machine ${idOrLabel}`);
    return record;
  }

  /** The sessions ever placed on a machine. */
  private sessionsOn(record: RunnerRecord) {
    if (!record.runnerId) return [];
    return this.deps.db
      .select({
        id: sessions.id,
        archivedAt: sessions.archivedAt,
        cwd: sessions.cwd,
        startMeta: sessions.startMeta,
      })
      .from(sessions)
      .where(eq(sessions.runnerId, record.runnerId))
      .all();
  }

  /**
   * Remove a machine: refused while sessions are placed on it that aren't archived, and while a
   * clone there holds work that exists nowhere else (uncommitted changes, unpushed commits,
   * stashes) unless `force`. Its runner is asked to exit; its files on the machine stay.
   */
  async remove(idOrLabel: string, opts: { force?: boolean } = {}): Promise<void> {
    const record = this.require(idOrLabel);
    const label = record.label ?? record.id;
    const placed = this.sessionsOn(record);
    const live = placed.filter((s) => !s.archivedAt);
    if (live.length > 0) {
      throw new ServiceError(
        409,
        "machine_in_use",
        `${label} still has ${live.length} session${live.length === 1 ? "" : "s"}; archive ${live.length === 1 ? "it" : "them"} first`,
      );
    }
    const port = this.port(record);
    if (!opts.force && placed.length > 0) {
      const kept = await this.unpushedOn(
        port,
        label,
        // Each session's folder, and the project clones their branches live in (§A.4).
        placed.flatMap((s) => [
          s.cwd,
          ...(s.startMeta?.cloneRepoPath ? [s.startMeta.cloneRepoPath] : []),
        ]),
      );
      if (kept) throw new ServiceError(409, "machine_unpushed", kept);
    }
    if (port?.isConnected()) {
      await port.request({ name: "runner.shutdown" }, 10_000).catch(() => undefined);
    }
    await this.deps.hub.remove(record.id, { deleted: true });
    this.statuses.delete(record.id);
    this.deps.log?.(`machines: removed ${label}`);
  }

  /** Why the machine's clones keep it (work there and nowhere else), or null. */
  private async unpushedOn(
    port: RunnerPort | undefined,
    label: string,
    folders: string[],
  ): Promise<string | null> {
    if (!port?.isConnected()) {
      return `${label} isn't connected, so its clones couldn't be checked for unpushed work. Connect it, or remove it anyway`;
    }
    for (const cwd of new Set(folders)) {
      try {
        const work = await port.request({ name: "git.unpushed", cwd }, UNPUSHED_MS);
        if (hasUnpushedWork(work)) {
          return `A clone on ${label} (${cwd}) has ${describeUnpushedWork(work)}. Push it first, or remove the machine anyway`;
        }
      } catch (error) {
        if (runnerErrorCode(error) === "cwd_missing") continue;
        return `A clone on ${label} (${cwd}) couldn't be checked: ${errorMessage(error)}`;
      }
    }
    return null;
  }

  /**
   * After a server restart: link again to every machine. Each link starts the machine's runner
   * if it isn't running; sessions continue there and the client resumes the journal from its
   * ack position. A machine that can't be reached is retried with backoff until it can.
   */
  reattach(): Promise<void> {
    this.reattached = this.reattachAll().catch((error: unknown) =>
      this.deps.log?.(`machines: reattach failed: ${errorMessage(error)}`),
    );
    return this.reattached;
  }

  private async reattachAll(): Promise<void> {
    for (const record of listRunnerRecords(this.deps.db)) {
      if (record.backend !== "ssh" || record.state === "deleted" || !record.sandboxRef) continue;
      if (this.deps.hub.client(record.id)) continue;
      const client = this.addRunner({
        id: record.id,
        destination: record.sandboxRef,
        label: record.label ?? record.id,
        weight: record.weight,
      });
      client
        .start()
        .catch((error: unknown) =>
          this.deps.log?.(`machines: ${record.label}: ${errorMessage(error)}`),
        );
    }
  }
}
