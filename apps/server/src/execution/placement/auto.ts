import {
  DEFAULT_MACHINE_WEIGHT,
  HOME_RUNNER_ID,
  type HostResources,
  type Project,
  type RunnerRecord,
} from "@codeden/contracts";
import type { RunnerPort } from "../../services/runner-port";
import type { MachineService } from "../ssh/machines";
import type { CapacityCache } from "./capacity";
import { type Candidate, type Capacity, choosePlacement, noPlacementReason } from "./score";

export interface AutoPlacementDeps {
  machines: Pick<MachineService, "records" | "port" | "providerReady">;
  /** The home runner, a candidate like any machine. */
  home: RunnerPort;
  /** Home's preference (its record's weight). */
  homeWeight: () => number;
  /** Whether a provider can start new work on Home now. */
  homeReady: (provider: string) => boolean;
  capacity: CapacityCache;
  now?: () => number;
  log?: (message: string) => void;
}

/** Where Automatic put a session: Home, or a machine's record; or why nowhere. */
export type AutoChoice =
  | { kind: "home" }
  | { kind: "machine"; record: RunnerRecord }
  | { kind: "none"; reason: string };

function toCapacity(r: HostResources | null): Capacity | null {
  if (!r) return null;
  return {
    cpuCount: r.cpuCount,
    cpuBusy: r.cpuBusy,
    totalMemoryBytes: r.totalMemoryBytes,
    availableMemoryBytes: r.availableMemoryBytes,
    sampledAtMs: Date.parse(r.sampledAt),
  };
}

/**
 * Automatic placement (`docs/machines-teams-and-agents.md` §A.5): ask Home and every machine
 * that could take the session for its free capacity (5 s deadline each, answers reused for
 * 15 s), score them (`score.ts`) and pick the highest.
 */
export class AutoPlacement {
  constructor(private readonly deps: AutoPlacementDeps) {}

  async choose(project: Pick<Project, "kind">, provider: string): Promise<AutoChoice> {
    const { machines, home, capacity } = this.deps;
    const homeCandidate = async (): Promise<Candidate> => ({
      id: HOME_RUNNER_ID,
      label: "Home",
      home: true,
      weight: this.deps.homeWeight(),
      connected: home.isConnected(),
      projectAllowed: true,
      providerReady: this.deps.homeReady(provider),
      capacity: toCapacity(await capacity.get(HOME_RUNNER_ID, home)),
    });
    const machineCandidate = async (record: RunnerRecord): Promise<Candidate> => {
      const port = machines.port(record);
      const connected = port?.isConnected() === true;
      const weight = record.weight ?? DEFAULT_MACHINE_WEIGHT;
      const projectAllowed = project.kind === "github";
      // Capacity is asked only of machines that could take the session.
      const usable = connected && weight > 0 && projectAllowed;
      const ready = usable
        ? (await machines.providerReady(record, provider))?.ready === true
        : false;
      return {
        id: record.id,
        label: record.label ?? record.id,
        home: false,
        weight,
        connected,
        projectAllowed,
        providerReady: ready,
        capacity: usable && ready ? toCapacity(await capacity.get(record.id, port)) : null,
      };
    };
    const candidates = await Promise.all([
      homeCandidate(),
      ...machines
        .records()
        // A person's own computer is never chosen automatically (§D.5).
        .filter((r) => r.runnerId && !r.ownerMemberId)
        .map(machineCandidate),
    ]);
    const { winner, scored } = choosePlacement(candidates, this.deps.now?.() ?? Date.now());
    this.deps.log?.(
      `placement: ${scored
        .map((s) => `${s.candidate.label}=${s.score?.toFixed(1) ?? s.skipped}`)
        .join(", ")} -> ${winner?.label ?? "none"}`,
    );
    if (!winner) return { kind: "none", reason: noPlacementReason(scored, provider) };
    if (winner.home) return { kind: "home" };
    const record = machines.records().find((r) => r.id === winner.id);
    return record ? { kind: "machine", record } : { kind: "none", reason: "The machine went away" };
  }
}
