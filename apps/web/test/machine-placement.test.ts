import type { Machine, RunnerRecord } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { withLiveState } from "@/lib/machines";
import {
  buildStartRequest,
  type DraftDefaults,
  emptyChoice,
  machineChoices,
  resolveDraftChoice,
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
    expect(request("vps-1", ["vps-1", "box"]).machine).toBe("vps-1");
  });

  it("falls back to the project setting for a removed machine or a draft that can't choose", () => {
    expect(request("gone", ["vps-1"])).not.toHaveProperty("machine");
    expect(request("home", [])).not.toHaveProperty("machine");
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
    providers: [],
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
