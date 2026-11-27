import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  busyFromCgroup,
  busyFromTimes,
  parseCgroupMemory,
  parseCpuMax,
  parseCpuUsageUsec,
  parseVmStat,
} from "../src/host/parse";
import { type HostProbe, sampleHostResources } from "../src/host/resources";

/**
 * `host.resources` (`docs/machines-teams-and-agents.md` §A.5): free capacity for automatic
 * placement, from fixture files and an injected clock, never the real machine or a real timer.
 */

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", "host", name), "utf8");
const GiB = 1024 ** 3;

describe("the parsers", () => {
  it("count macOS's reclaimable pages as available", () => {
    // (free 168955 + inactive 854008 + purgeable 3426 + speculative 14373) × 16 KiB
    expect(parseVmStat(fixture("vm_stat.txt"))).toBe((168955 + 854008 + 3426 + 14373) * 16384);
    expect(parseVmStat("nothing here")).toBeNull();
  });

  it("read a cgroup's CPU limit, capped at the host's count", () => {
    expect(parseCpuMax(fixture("cpu.max.limited"), 11)).toBe(2);
    expect(parseCpuMax(fixture("cpu.max.limited"), 1)).toBe(1);
    expect(parseCpuMax(fixture("cpu.max.unlimited"), 11)).toBeNull();
    expect(parseCpuMax(null, 11)).toBeNull();
    expect(parseCpuUsageUsec(fixture("cpu.stat.before"))).toBe(5_000_000);
  });

  it("read a cgroup's memory limit, counting inactive page cache as free", () => {
    // 4 GiB limit, 3 GiB charged of which 1 GiB inactive file cache: 2 GiB available.
    expect(
      parseCgroupMemory(
        fixture("memory.max"),
        fixture("memory.current"),
        fixture("memory.stat"),
        7 * GiB,
      ),
    ).toEqual({ total: 4 * GiB, available: 2 * GiB });
    expect(
      parseCgroupMemory(fixture("memory.max.unlimited"), fixture("memory.current"), null, 7 * GiB),
    ).toBeNull();
    expect(parseCgroupMemory(fixture("memory.max"), null, null, 7 * GiB)).toBeNull();
  });

  it("turn two samples into a busy share", () => {
    expect(busyFromTimes({ idle: 100, total: 200 }, { idle: 150, total: 400 })).toBe(0.75);
    expect(busyFromTimes({ idle: 1, total: 1 }, { idle: 1, total: 1 })).toBe(0);
    // 1 s of CPU over 1 s on 2 CPUs: half busy.
    expect(busyFromCgroup(5_000_000, 6_000_000, 1_000, 2)).toBe(0.5);
    expect(busyFromCgroup(0, 9_000_000, 1_000, 2)).toBe(1);
  });
});

/** A probe over fixture files: CPU times move by `busy` between the two samples. */
function probe(over: Partial<HostProbe> & { files?: Record<string, string[]> }): HostProbe {
  let clock = 1_800_000_000_000;
  const reads: Record<string, number> = {};
  const cpu = (idle: number) => ({
    model: "x",
    speed: 1,
    times: { user: 1000 - idle, nice: 0, sys: 0, idle, irq: 0 },
  });
  let sample = 0;
  const files = over.files ?? {};
  return {
    platform: "linux",
    cpus: () => (sample++ < 2 ? [cpu(500), cpu(500)] : [cpu(600), cpu(600)]),
    totalmem: () => 7 * GiB,
    freemem: () => 3 * GiB,
    readFile: async (path) => {
      const name = path.split("/").pop() as string;
      const list = files[name];
      if (!list) return null;
      reads[name] = (reads[name] ?? -1) + 1;
      return list[Math.min(reads[name], list.length - 1)] ?? null;
    },
    vmStat: async () => null,
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
}

describe("sampling", () => {
  it("uses the host's numbers without a cgroup limit", async () => {
    const result = await sampleHostResources(probe({}));
    expect(result).toEqual({
      cpuCount: 2,
      cpuBusy: 0,
      totalMemoryBytes: 7 * GiB,
      availableMemoryBytes: 3 * GiB,
      sampledAt: new Date(1_800_000_001_000).toISOString(),
    });
  });

  it("honours a container's cgroup v2 limits", async () => {
    const result = await sampleHostResources(
      probe({
        cpus: () =>
          Array.from({ length: 11 }, () => ({
            model: "x",
            speed: 1,
            times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
          })),
        files: {
          "cpu.max": [fixture("cpu.max.limited")],
          "cpu.stat": [fixture("cpu.stat.before"), fixture("cpu.stat.after")],
          "memory.max": [fixture("memory.max")],
          "memory.current": [fixture("memory.current")],
          "memory.stat": [fixture("memory.stat")],
        },
      }),
    );
    expect(result).toMatchObject({
      cpuCount: 2,
      cpuBusy: 0.5,
      totalMemoryBytes: 4 * GiB,
      availableMemoryBytes: 2 * GiB,
    });
  });

  it("counts reclaimable memory on macOS", async () => {
    const result = await sampleHostResources(
      probe({
        platform: "darwin",
        totalmem: () => 64 * GiB,
        vmStat: async () => fixture("vm_stat.txt"),
      }),
    );
    expect(result.availableMemoryBytes).toBe((168955 + 854008 + 3426 + 14373) * 16384);
  });
});
