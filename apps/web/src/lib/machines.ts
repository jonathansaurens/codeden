import type { Machine, RunnerRecord } from "@codeden/contracts";
import { useQuery } from "@tanstack/react-query";
import { useClient } from "./api";

/** The machines query (`GET /api/machines`); invalidate it after adding or removing one. */
export const machinesKey = ["machines"] as const;

/**
 * Every machine and the command they run CodeDen with. A server without machines answers with an
 * error; callers treat that as none.
 */
export function useMachines(opts: { enabled?: boolean } = {}) {
  const client = useClient();
  return useQuery({
    queryKey: machinesKey,
    queryFn: () => client.machines(),
    enabled: opts.enabled ?? true,
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
