import type { HostResources, Machine, RunnerRecord } from "@codeden/contracts";
import { useQuery } from "@tanstack/react-query";
import { useClient } from "./api";

/** The machines query (`GET /api/machines`); invalidate it after adding or removing one. */
export const machinesKey = ["machines"] as const;

/**
 * Every machine and the command they run CodeDen with. A server without machines answers with an
 * error; callers treat that as none.
 */
export function useMachines(opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  const client = useClient();
  return useQuery({
    queryKey: machinesKey,
    queryFn: () => client.machines(),
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * The machines with their runners' live state from the realtime runner list (matched by record
 * id): state and last error always, version and last seen when the runner reports them. A machine
 * without a live record keeps what the query had.
 */
export function withLiveState(machines: readonly Machine[], runners: readonly RunnerRecord[]) {
  const live = new Map(runners.map((r) => [r.id, r]));
  return machines.map((m): Machine => {
    const r = live.get(m.id);
    if (!r) return m;
    return {
      ...m,
      state: r.state,
      lastError: r.lastError,
      version: r.version ?? m.version,
      lastSeenAt: r.lastSeenAt ?? m.lastSeenAt,
    };
  });
}

/**
 * The machine a session runs on: the machine's runner record (over SSH, or someone's own
 * computer) whose `runnerId` is the session's. Undefined for Home and for any other runner.
 */
export function sessionMachine(
  runnerId: string | null | undefined,
  runners: readonly RunnerRecord[],
): RunnerRecord | undefined {
  if (!runnerId) return undefined;
  return runners.find(
    (r) => (r.backend === "ssh" || r.backend === "connected") && r.runnerId === runnerId,
  );
}

/** "Alice's computer" for a person's own computer (§D.5), else the machine's label. */
export function machineTitle(m: Pick<Machine, "label" | "owner">): string {
  return m.owner ? `${m.owner.name}'s computer` : m.label;
}

/**
 * The machines a person may pick for one session: every machine over SSH, and their own
 * computers (someone else's takes only its person's work, §D.5). `meId` undefined (not loaded
 * yet) counts as the first owner, as a single-user install is.
 */
export function pickableMachines(machines: readonly Machine[], meId: string | undefined) {
  return machines.filter((m) => !m.owner || m.owner.id === (meId ?? "owner"));
}

/** The machines a project's setting may name: never someone's own computer. */
export function projectMachines(machines: readonly Machine[]) {
  return machines.filter((m) => !m.owner);
}

const GIB = 1024 ** 3;
const gib = (bytes: number) => {
  const v = bytes / GIB;
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "");
};

/** "4 cores · CPU 23% · 3.1 of 8 GiB free", or "Capacity unknown" before a host reports any. */
export function capacityLine(resources: HostResources | null | undefined): string {
  if (!resources) return "Capacity unknown";
  const cores = Number.isInteger(resources.cpuCount)
    ? String(resources.cpuCount)
    : resources.cpuCount.toFixed(1);
  return [
    `${cores} core${resources.cpuCount === 1 ? "" : "s"}`,
    `CPU ${Math.round(resources.cpuBusy * 100)}%`,
    `${gib(resources.availableMemoryBytes)} of ${gib(resources.totalMemoryBytes)} GiB free`,
  ].join(" · ");
}
