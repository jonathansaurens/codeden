import type { HostResources, RunnerRecord } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { AutoPlacement } from "../src/execution/placement/auto";
import { CapacityCache } from "../src/execution/placement/capacity";
import type { RunnerPort } from "../src/services/runner-port";
import { placeAutomatically } from "../src/services/sessions/placement";

/**
 * Automatic placement (`docs/machines-teams-and-agents.md` §A.5) over scripted runners: each
 * "machine" answers `host.resources` from a script, so placement is checked without processes,
 * sockets or real timers.
 */

const NOW = Date.parse("2026-11-25T10:00:00.000Z");
const GiB = 1024 ** 3;

function resources(cpuBusy: number, cpuCount = 4, free = 0.5): HostResources {
  return {
    cpuCount,
    cpuBusy,
    totalMemoryBytes: 8 * GiB,
    availableMemoryBytes: free * 8 * GiB,
    sampledAt: new Date(NOW - 500).toISOString(),
  };
}

interface Scripted {
  connected: boolean;
  answer: HostResources | Error;
  asked: number;
}

function port(s: Scripted): RunnerPort {
  return {
    isConnected: () => s.connected,
    runnerId: () => "r",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => s.connected,
    request: (async () => {
      s.asked++;
      if (s.answer instanceof Error) throw s.answer;
      return s.answer;
    }) as RunnerPort["request"],
  };
}

const record = (label: string, weight: number | null = null): RunnerRecord => ({
  id: `m-${label}`,
  backend: "ssh",
  home: false,
  runnerId: `r-${label}`,
  sandboxRef: `dev@${label}`,
  label,
  weight,
  projectId: null,
  sessionId: null,
  state: "connected",
  version: "0.7.10",
  imageVersion: null,
  createdAt: "2026-11-25T09:00:00.000Z",
  lastSeenAt: null,
  lastError: null,
});

/** Home and machines, each scripted; `ready` lists where the provider is signed in. */
function world(opts: {
  home: Partial<Scripted>;
  machines: Array<{ record: RunnerRecord } & Partial<Scripted>>;
  ready: string[];
  homeWeight?: number;
}) {
  const script = (s: Partial<Scripted>): Scripted => ({
    connected: true,
    answer: resources(0.5),
    asked: 0,
    ...s,
  });
  const home = script(opts.home);
  const machines = opts.machines.map((m) => ({ record: m.record, s: script(m) }));
  let clock = NOW;
  const capacity = new CapacityCache(() => clock);
  const auto = new AutoPlacement({
    machines: {
      records: () => machines.map((m) => m.record),
      port: (r) => port(machines.find((m) => m.record.id === r.id)?.s as Scripted),
      providerReady: async (r) => ({
        id: "codex",
        name: "Codex",
        ready: opts.ready.includes(r.label as string),
        reason: null,
      }),
    },
    home: port(home),
    homeWeight: () => opts.homeWeight ?? 50,
    homeReady: () => opts.ready.includes("Home"),
    capacity,
    now: () => clock,
  });
  return {
    auto,
    home,
    machines,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const github = { kind: "github" as const };

describe("automatic placement", () => {
  it("puts the session on the machine with the most free capacity", async () => {
    const w = world({
      home: { answer: resources(0.8) },
      machines: [
        { record: record("vps-1"), answer: resources(0.6) },
        { record: record("vps-2"), answer: resources(0.1) },
      ],
      ready: ["Home", "vps-1", "vps-2"],
    });
    const choice = await w.auto.choose(github, "codex");
    expect(choice).toMatchObject({ kind: "machine", record: { label: "vps-2" } });
  });

  it("chooses Home when it has the most room, and only by name a Manual only machine", async () => {
    const w = world({
      home: { answer: resources(0.1, 8) },
      machines: [{ record: record("big", 0), answer: resources(0, 64) }],
      ready: ["Home", "big"],
    });
    expect(await w.auto.choose(github, "codex")).toEqual({ kind: "home" });
    // Manual only is never asked for its capacity.
    expect(w.machines[0]?.s.asked).toBe(0);
  });

  it("only places where the provider is signed in, and keeps local projects on Home", async () => {
    const w = world({
      home: { answer: resources(0.9) },
      machines: [
        { record: record("idle"), answer: resources(0) },
        { record: record("ready"), answer: resources(0.7) },
      ],
      ready: ["Home", "ready"],
    });
    expect(await w.auto.choose(github, "codex")).toMatchObject({ record: { label: "ready" } });
    expect(await w.auto.choose({ kind: "local" }, "codex")).toEqual({ kind: "home" });
  });

  it("treats a failed or late answer as missing, and reuses answers for 15 s", async () => {
    const w = world({
      home: { connected: false },
      machines: [
        { record: record("slow"), answer: new Error("Runner command host.resources timed out") },
        { record: record("ok"), answer: resources(0.5) },
      ],
      ready: ["slow", "ok"],
    });
    expect(await w.auto.choose(github, "codex")).toMatchObject({ record: { label: "ok" } });
    const ok = w.machines[1]?.s as Scripted;
    expect(ok.asked).toBe(1);
    w.advance(10_000);
    await w.auto.choose(github, "codex");
    expect(ok.asked).toBe(1);
    w.advance(6_000);
    ok.answer = { ...resources(0.5), sampledAt: new Date(NOW + 16_000).toISOString() };
    await w.auto.choose(github, "codex");
    expect(ok.asked).toBe(2);
  });

  it("finds nothing when every candidate is busy, and says so", async () => {
    const w = world({
      home: { answer: resources(0.99) },
      machines: [{ record: record("vps-1"), answer: resources(0.2, 4, 0.03) }],
      ready: ["Home", "vps-1"],
    });
    expect(await w.auto.choose(github, "codex")).toEqual({
      kind: "none",
      reason: "All machines are busy",
    });
  });
});

describe("when nothing qualifies", () => {
  const none = { choose: async () => ({ kind: "none" as const, reason: "All machines are busy" }) };
  const project = { kind: "github" } as Parameters<typeof placeAutomatically>[1];

  it("refuses a person's start with why, so the form can offer Home", async () => {
    await expect(
      placeAutomatically(none, project, "codex", { kind: "user" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "no_machine",
      message: "All machines are busy. Run it on Home instead?",
    });
  });

  it("runs the PM's or an automation's session on Home, with a note for its header", async () => {
    for (const startedBy of [{ kind: "pm" as const }, { kind: "automation" as const, id: "a1" }]) {
      expect(await placeAutomatically(none, project, "codex", startedBy)).toEqual({
        runnerId: null,
        note: "Automatic placement found no free machine (All machines are busy); ran on Home",
      });
    }
  });

  it("places on the chosen machine's runner", async () => {
    const auto = { choose: async () => ({ kind: "machine" as const, record: record("vps-1") }) };
    expect(await placeAutomatically(auto, project, "codex", { kind: "user" })).toEqual({
      runnerId: "r-vps-1",
      note: null,
    });
  });
});
