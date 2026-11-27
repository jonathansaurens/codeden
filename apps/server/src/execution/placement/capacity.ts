import type { HostResources } from "@codeden/contracts";
import type { RunnerPort } from "../../services/runner-port";

/** How long a capacity answer is reused (§A.5). */
export const CAPACITY_REUSE_MS = 15_000;
/** How long a runner gets to answer `host.resources` before it counts as missing. */
export const CAPACITY_DEADLINE_MS = 5_000;

interface Entry {
  at: number;
  value: HostResources | null;
  pending?: Promise<HostResources | null>;
}

/**
 * Capacity answers (`host.resources`) by runner record id, asked with a 5 s deadline and reused
 * for 15 s (`docs/machines-teams-and-agents.md` §A.5). A runner that isn't connected, fails or
 * misses the deadline answers null, which the scorer skips. Concurrent asks share one request.
 */
export class CapacityCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The last answer for `id`, whatever its age (for display). */
  last(id: string): HostResources | null {
    return this.entries.get(id)?.value ?? null;
  }

  /** A fresh-enough answer for `id`, asking its runner when the last one is older than 15 s. */
  async get(id: string, port: RunnerPort | undefined): Promise<HostResources | null> {
    const entry = this.entries.get(id);
    if (entry?.pending) return entry.pending;
    if (entry && this.now() - entry.at < CAPACITY_REUSE_MS) return entry.value;
    if (!port?.isConnected()) return null;
    const pending = port
      .request({ name: "host.resources" }, CAPACITY_DEADLINE_MS)
      .catch(() => null)
      .then((value) => {
        this.entries.set(id, { at: this.now(), value });
        return value;
      });
    this.entries.set(id, { at: entry?.at ?? 0, value: entry?.value ?? null, pending });
    return pending;
  }

  /** Forget a runner (a removed machine). */
  forget(id: string): void {
    this.entries.delete(id);
  }
}
