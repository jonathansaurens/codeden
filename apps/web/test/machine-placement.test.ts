import type { Machine, RunnerRecord } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { capacityLine, sessionMachine, withLiveState } from "@/lib/machines";
import {
  buildStartRequest,
  type DraftDefaults,
  emptyChoice,
  machineChoices,
  resolveDraftChoice,
  startOnHome,
} from "@/lib/new-session";

const defaults = (machines: string[]): DraftDefaults => ({
  providers: [],
  project: undefined,
  agent: null,
  defaultAutonomy: "auto",
  machines,
});
const request = (machine: string | null | undefined, offered: string[]) =>
  buildStartRequest(
    "p1",
    { text: "Go" },
    resolveDraftChoice({ ...emptyChoice, machine }, defaults(offered)),
    "",
  );

describe("Runs on (the New session draft's machine)", () => {
  it("sends nothing for the project setting, home or the machine's label otherwise", () => {
    expect(request(null, ["vps-1"])).not.toHaveProperty("machine");
    expect(request(undefined, ["vps-1"])).not.toHaveProperty("machine");
    expect(request("home", ["vps-1"]).machine).toBe("home");
    expect(request("auto", ["vps-1"]).machine).toBe("auto");
    expect(request("vps-1", ["vps-1", "box"]).machine).toBe("vps-1");
  });

  it("falls back to the project setting for a removed machine or a draft that can't choose", () => {
    expect(request("gone", ["vps-1"])).not.toHaveProperty("machine");
    expect(request("home", [])).not.toHaveProperty("machine");
  });

  it("sends the draft that found no machine again on Home, as it was otherwise", () => {
    const auto = request("auto", ["vps-1"]);
    expect(startOnHome(auto)).toEqual({ ...auto, machine: "home" });
    const fromProject = request(null, ["vps-1"]);
    expect(startOnHome(fromProject)).toEqual({ ...fromProject, machine: "home" });
  });

  it("offers machines only to GitHub projects that don't run in Docker", () => {
    const github = { kind: "github", execution: { backend: "local" } };
    expect(machineChoices(github, ["vps-1"])).toEqual(["vps-1"]);
    expect(machineChoices({ ...github, execution: { backend: "ssh" } }, ["vps-1"])).toEqual([
      "vps-1",
    ]);
    expect(machineChoices({ ...github, execution: { backend: "docker" } }, ["vps-1"])).toEqual([]);
    expect(machineChoices({ kind: "local" }, ["vps-1"])).toEqual([]);
    expect(machineChoices(undefined, ["vps-1"])).toEqual([]);
  });
});

describe("withLiveState", () => {
  const machine: Machine = {
    id: "m1",
    label: "vps-1",
    destination: "me@vps",
    weight: 50,
    state: "connected",
    version: "0.1.0",
    platform: "linux",
    arch: "x64",
    lastError: null,
    lastSeenAt: "2026-11-25T08:00:00.000Z",
    sessions: 2,
    resources: null,
    providers: [],
    reinstalled: false,
  };
  const runner = (over: Partial<RunnerRecord>): RunnerRecord => ({
    id: "m1",
    backend: "ssh",
    home: false,
    runnerId: null,
    sandboxRef: "me@vps",
    label: "vps-1",
    weight: 50,
    projectId: null,
    sessionId: null,
    state: "connected",
    version: null,
    imageVersion: null,
    createdAt: "2026-11-20T08:00:00.000Z",
    lastSeenAt: null,
    lastError: null,
    ...over,
  });

  it("takes state and error from the live runner, keeping what it doesn't report", () => {
    const [m] = withLiveState([machine], [runner({ state: "failed", lastError: "ssh: timeout" })]);
    expect(m).toMatchObject({
      state: "failed",
      lastError: "ssh: timeout",
      version: "0.1.0",
      lastSeenAt: machine.lastSeenAt,
      sessions: 2,
    });
  });

  it("keeps the query's machine when no runner matches its id", () => {
    expect(withLiveState([machine], [runner({ id: "other", state: "failed" })])).toEqual([machine]);
  });
});

describe("the session's machine and capacity", () => {
  const record = (over: Partial<RunnerRecord>): RunnerRecord => ({
    id: "machine-vps-1",
    backend: "ssh",
    home: false,
    runnerId: "runner-vps-1",
    sandboxRef: "me@vps",
    label: "vps-1",
    weight: 50,
    projectId: null,
    sessionId: null,
    state: "connected",
    version: null,
    imageVersion: null,
    createdAt: "2026-11-20T08:00:00.000Z",
    lastSeenAt: null,
    lastError: null,
    ...over,
  });
  const home = record({ id: "home", backend: "local", home: true, runnerId: "runner-local" });
  const vps = record({});

  it("finds the machine by the session's runner id, never Home or another backend", () => {
    expect(sessionMachine("runner-vps-1", [home, vps])).toBe(vps);
    expect(sessionMachine("runner-local", [home, vps])).toBeUndefined();
    expect(sessionMachine("machine-vps-1", [home, vps])).toBeUndefined();
    expect(sessionMachine(null, [home, vps])).toBeUndefined();
    const docker = record({ backend: "docker", runnerId: "runner-box" });
    expect(sessionMachine("runner-box", [docker])).toBeUndefined();
  });

  it("reads capacity compactly", () => {
    const GiB = 1024 ** 3;
    expect(
      capacityLine({
        cpuCount: 4,
        cpuBusy: 0.234,
        totalMemoryBytes: 8 * GiB,
        availableMemoryBytes: 3.14 * GiB,
        sampledAt: "2026-11-25T08:00:00.000Z",
      }),
    ).toBe("4 cores · CPU 23% · 3.1 of 8 GiB free");
    expect(capacityLine(null)).toBe("Capacity unknown");
  });
});
