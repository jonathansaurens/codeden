import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  busyFromCgroup,
  busyFromTimes,
  parseCgroupMemory,
  parseCpuMax,
  parseCpuUsageUsec,
  parseVmStat,
  sumCpuTimes,
} from "./parse";

/** What `host.resources` answers (`HostResources`). */
export interface HostResourcesSample {
  cpuCount: number;
  cpuBusy: number;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  sampledAt: string;
}

/** Everything the sampler reads, injectable so tests need no real machine or timer. */
export interface HostProbe {
  platform: NodeJS.Platform;
  cpus: () => ReturnType<typeof cpus>;
  totalmem: () => number;
  freemem: () => number;
  /** A file's text, or null when it can't be read. */
  readFile: (path: string) => Promise<string | null>;
  /** `vm_stat`'s output on macOS, or null. */
  vmStat: () => Promise<string | null>;
  /** Wait between the two CPU samples. */
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

const CGROUP = "/sys/fs/cgroup";
/** How long CPU use is sampled over. */
export const SAMPLE_MS = 1_000;

export const realProbe: HostProbe = {
  platform: process.platform,
  cpus,
  totalmem,
  freemem,
  readFile: (path) => readFile(path, "utf8").catch(() => null),
  vmStat: () =>
    new Promise((resolve) => {
      execFile("vm_stat", { timeout: 5_000 }, (error, stdout) => resolve(error ? null : stdout));
    }),
  wait: (ms) => delay(ms).then(() => undefined),
  now: () => Date.now(),
};

/**
 * Sample the machine's free capacity for automatic placement (§A.5): its CPUs, how busy they
 * were over about a second, and its total and available memory. On Linux, cgroup v2 limits win
 * when set (a container: `cpu.max`, `cpu.stat`, `memory.max`, `memory.current` less
 * `inactive_file`), since `/proc` and `os.cpus()` report the whole host there; unlimited or
 * cgroup v1 falls back to the host's numbers. On macOS available memory counts reclaimable pages
 * (`vm_stat`), since `os.freemem()` reports only free ones there.
 */
export async function sampleHostResources(
  probe: HostProbe = realProbe,
  sampleMs = SAMPLE_MS,
): Promise<HostResourcesSample> {
  const hostCpus = Math.max(1, probe.cpus().length);
  const hostTotal = probe.totalmem();
  const linux = probe.platform === "linux";
  const read = (name: string) =>
    linux ? probe.readFile(`${CGROUP}/${name}`) : Promise.resolve(null);

  const cgroupCpus = parseCpuMax(await read("cpu.max"), hostCpus);
  const usageBefore = cgroupCpus ? parseCpuUsageUsec(await read("cpu.stat")) : null;
  const timesBefore = sumCpuTimes(probe.cpus());
  const startedAt = probe.now();
  await probe.wait(sampleMs);
  const elapsed = probe.now() - startedAt;
  const usageAfter = cgroupCpus ? parseCpuUsageUsec(await read("cpu.stat")) : null;

  let cpuCount = hostCpus;
  let cpuBusy = busyFromTimes(timesBefore, sumCpuTimes(probe.cpus()));
  if (cgroupCpus && usageBefore !== null && usageAfter !== null) {
    cpuCount = cgroupCpus;
    cpuBusy = busyFromCgroup(usageBefore, usageAfter, elapsed, cgroupCpus);
  }

  let totalMemoryBytes = hostTotal;
  let availableMemoryBytes = probe.freemem();
  const cgroupMemory = linux
    ? parseCgroupMemory(
        await read("memory.max"),
        await read("memory.current"),
        await read("memory.stat"),
        hostTotal,
      )
    : null;
  if (cgroupMemory) {
    totalMemoryBytes = cgroupMemory.total;
    availableMemoryBytes = cgroupMemory.available;
  } else if (probe.platform === "darwin") {
    const reclaimable = parseVmStat((await probe.vmStat()) ?? "");
    if (reclaimable !== null) availableMemoryBytes = Math.min(reclaimable, hostTotal);
  }
  return {
    cpuCount,
    cpuBusy,
    totalMemoryBytes,
    availableMemoryBytes,
    sampledAt: new Date(probe.now()).toISOString(),
  };
}
