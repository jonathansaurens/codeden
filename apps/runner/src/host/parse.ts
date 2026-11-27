/**
 * Parsers for what `host.resources` reads (`docs/machines-teams-and-agents.md` §A.5): macOS's
 * `vm_stat`, Linux cgroup v2 limits and usage. Pure, so they are tested with fixture text.
 */

/** Available memory from `vm_stat`: free, inactive, purgeable and speculative pages. */
export function parseVmStat(text: string): number | null {
  const size = /page size of (\d+) bytes/.exec(text);
  if (!size) return null;
  const pages = (name: string) => {
    const match = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?\\s*$`, "m").exec(text);
    return match ? Number(match[1]) : 0;
  };
  const free = /^Pages free:/m.test(text);
  if (!free) return null;
  const reclaimable = pages("free") + pages("inactive") + pages("purgeable") + pages("speculative");
  return reclaimable * Number(size[1]);
}

/**
 * The CPUs a cgroup v2 `cpu.max` allows ("200000 100000" → 2; "max 100000" → null, unlimited),
 * capped at the host's count. Null when it sets no limit or can't be read.
 */
export function parseCpuMax(text: string | null, hostCpus: number): number | null {
  if (!text) return null;
  const [quota, period] = text.trim().split(/\s+/);
  if (!quota || quota === "max") return null;
  const q = Number(quota);
  const p = Number(period ?? "100000");
  if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null;
  return Math.min(q / p, hostCpus);
}

/** `usage_usec` from a cgroup v2 `cpu.stat`; null when absent. */
export function parseCpuUsageUsec(text: string | null): number | null {
  const match = text ? /^usage_usec\s+(\d+)\s*$/m.exec(text) : null;
  return match ? Number(match[1]) : null;
}

/** A field of a cgroup v2 `memory.stat` (bytes); 0 when absent. */
export function memoryStatField(text: string | null, field: string): number {
  const match = text ? new RegExp(`^${field}\\s+(\\d+)\\s*$`, "m").exec(text) : null;
  return match ? Number(match[1]) : 0;
}

/**
 * A cgroup v2 memory limit and what is left of it: total is `memory.max` (capped at the host's
 * memory), used is `memory.current` minus the reclaimable page cache (`inactive_file`). Null
 * when there is no limit (`max`) or the files can't be read.
 */
export function parseCgroupMemory(
  max: string | null,
  current: string | null,
  stat: string | null,
  hostTotal: number,
): { total: number; available: number } | null {
  if (!max || !current) return null;
  const limit = max.trim();
  if (limit === "max") return null;
  const total = Math.min(Number(limit), hostTotal);
  const usage = Number(current.trim());
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(usage)) return null;
  const used = Math.max(0, usage - memoryStatField(stat, "inactive_file"));
  return { total, available: Math.max(0, total - used) };
}

/** The CPU times `os.cpus()` reports, summed: what a busy share is computed from. */
export interface CpuTimes {
  idle: number;
  total: number;
}

/** Sum the times of every CPU. */
export function sumCpuTimes(
  cpus: ReadonlyArray<{
    times: { user: number; nice: number; sys: number; idle: number; irq: number };
  }>,
): CpuTimes {
  return cpus.reduce(
    (sum, { times: t }) => ({
      idle: sum.idle + t.idle,
      total: sum.total + t.user + t.nice + t.sys + t.idle + t.irq,
    }),
    { idle: 0, total: 0 },
  );
}

/** The busy share between two samples of the host's CPU times (0 to 1). */
export function busyFromTimes(before: CpuTimes, after: CpuTimes): number {
  const total = after.total - before.total;
  if (total <= 0) return 0;
  return clamp(1 - (after.idle - before.idle) / total);
}

/** The busy share of a cgroup's CPUs between two `usage_usec` readings `elapsedMs` apart. */
export function busyFromCgroup(
  beforeUsec: number,
  afterUsec: number,
  elapsedMs: number,
  cpus: number,
): number {
  if (elapsedMs <= 0 || cpus <= 0) return 0;
  return clamp((afterUsec - beforeUsec) / (elapsedMs * 1000 * cpus));
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}
