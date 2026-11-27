import { describe, expect, it } from "vitest";
import {
  type Candidate,
  choosePlacement,
  noPlacementReason,
  scoreCandidate,
} from "../src/execution/placement/score";

/** Automatic placement (`docs/machines-teams-and-agents.md` §A.5): the scorer, every rule. */

const NOW = 1_800_000_000_000;
const GiB = 1024 ** 3;

function machine(
  label: string,
  over: Partial<Candidate> = {},
  cap: Partial<Candidate["capacity"]> = {},
): Candidate {
  return {
    id: `m-${label}`,
    label,
    home: false,
    weight: 50,
    connected: true,
    projectAllowed: true,
    providerReady: true,
    capacity: {
      cpuCount: 4,
      cpuBusy: 0.5,
      totalMemoryBytes: 8 * GiB,
      availableMemoryBytes: 4 * GiB,
      sampledAtMs: NOW - 1_000,
      ...cap,
    },
    ...over,
  };
}
const home = (over: Partial<Candidate> = {}, cap: Partial<Candidate["capacity"]> = {}) =>
  machine("Home", { id: "home", home: true, ...over }, cap);

describe("the score", () => {
  it("is preference × cores × free CPU share × free memory share", () => {
    // 50 × 4 × 0.5 × 0.5
    expect(scoreCandidate(machine("a"), NOW).score).toBe(50);
    expect(
      scoreCandidate(machine("a", { weight: 100 }, { cpuCount: 8, cpuBusy: 0.25 }), NOW).score,
    ).toBe(100 * 8 * 0.75 * 0.5);
  });

  it.each([
    ["disconnected", { connected: false }, {}],
    ["manual_only", { weight: 0 }, {}],
    ["project_not_allowed", { projectAllowed: false }, {}],
    ["provider_not_ready", { providerReady: false }, {}],
    ["no_capacity", { capacity: null }, {}],
    ["stale_capacity", {}, { sampledAtMs: NOW - 15_001 }],
    ["cpu_busy", {}, { cpuBusy: 0.95 }],
    ["memory_low", {}, { availableMemoryBytes: 0.05 * 8 * GiB }],
  ] as const)("skips a candidate: %s", (reason, over, cap) => {
    expect(scoreCandidate(machine("a", over as Partial<Candidate>, cap), NOW).skipped).toBe(reason);
  });

  it("keeps a candidate just inside every limit", () => {
    const edge = machine(
      "a",
      {},
      {
        sampledAtMs: NOW - 15_000,
        cpuBusy: 0.949,
        availableMemoryBytes: 0.051 * 8 * GiB,
      },
    );
    expect(scoreCandidate(edge, NOW).score).toBeGreaterThan(0);
  });
});

describe("choosing", () => {
  it("picks the highest score", () => {
    const busy = machine("busy", {}, { cpuBusy: 0.9 });
    const idle = machine("idle", {}, { cpuBusy: 0.1 });
    expect(choosePlacement([busy, idle, home({}, { cpuBusy: 0.8 })], NOW).winner?.label).toBe(
      "idle",
    );
  });

  it("lets preference outweigh a little more capacity", () => {
    const preferred = machine("preferred", { weight: 100 }, { cpuBusy: 0.5 });
    const normal = machine("normal", { weight: 50 }, { cpuBusy: 0.1 });
    expect(choosePlacement([normal, preferred], NOW).winner?.label).toBe("preferred");
  });

  it("breaks a tie for Home, then the higher preference, then the first label", () => {
    expect(choosePlacement([machine("a"), home()], NOW).winner?.home).toBe(true);
    // Equal scores with different preferences: 100 × 2 cores vs 50 × 4 cores.
    const fewer = machine("z", { weight: 100 }, { cpuCount: 2 });
    expect(choosePlacement([machine("a"), fewer], NOW).winner?.label).toBe("z");
    expect(choosePlacement([machine("b"), machine("a")], NOW).winner?.label).toBe("a");
  });

  it("finds no winner when nothing qualifies, with every reason kept", () => {
    const choice = choosePlacement([machine("a", { connected: false }), home({ weight: 0 })], NOW);
    expect(choice.winner).toBeNull();
    expect(choice.scored.map((s) => s.skipped)).toEqual(["disconnected", "manual_only"]);
  });
});

describe("why nothing qualified", () => {
  const reason = (...cs: Candidate[]) =>
    noPlacementReason(choosePlacement(cs, NOW).scored, "codex");

  it("names the provider when it is signed in nowhere", () => {
    expect(reason(machine("a", { providerReady: false }), home({ providerReady: false }))).toBe(
      "No machine has codex installed and signed in",
    );
  });

  it("says everything is busy", () => {
    expect(reason(machine("a", {}, { cpuBusy: 0.99 }), home({ providerReady: false }))).toBe(
      "All machines are busy",
    );
  });

  it("says when no capacity came back, when all are Manual only, and when none is connected", () => {
    expect(reason(machine("a", { capacity: null }))).toBe(
      "No machine answered with its free capacity in time",
    );
    expect(reason(machine("a", { weight: 0 }), home({ weight: 0 }))).toBe(
      "Every machine is set to Manual only",
    );
    expect(reason(machine("a", { connected: false }))).toBe("No machine is connected");
    expect(reason(machine("a", { projectAllowed: false }), home({ weight: 0 }))).toBe(
      "Machines need a GitHub project",
    );
  });
});
