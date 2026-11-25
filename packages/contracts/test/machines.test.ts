import { describe, expect, it } from "vitest";
import {
  AddMachineRequest,
  EventEnvelope,
  MACHINE_PREFERENCES,
  Machine,
  MachineLabel,
  MachinesResponse,
  MachineWeight,
  Project,
  RunnerCommand,
  RunnerCommandResults,
  RunnerRecord,
  SessionPlacement,
  SshDestination,
  StartSessionRequest,
  UpdateProjectRequest,
} from "../src";
import { sampleProject, ts } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const machineRecord: RunnerRecord = {
  id: "m-vps1",
  backend: "ssh",
  home: false,
  runnerId: "r-vps1",
  sandboxRef: "dev@vps-1",
  label: "vps-1",
  weight: 100,
  projectId: null,
  sessionId: null,
  state: "connected",
  version: "0.7.10",
  imageVersion: null,
  createdAt: ts,
  lastSeenAt: ts,
  lastError: null,
};

const machine: Machine = {
  id: "m-vps1",
  label: "vps-1",
  destination: "dev@vps-1",
  weight: 50,
  state: "connected",
  version: "0.7.10",
  platform: "linux",
  arch: "x64",
  lastError: null,
  lastSeenAt: ts,
  sessions: 2,
  providers: [{ id: "claude", name: "Claude Code", ready: false, reason: "not signed in" }],
};

describe("machines", () => {
  it("round-trips a machine's runner record and its registration event", () => {
    roundTrip(RunnerRecord, machineRecord);
    roundTrip(EventEnvelope, {
      seq: 1,
      sessionId: null,
      ts,
      type: "runner.registered",
      payload: { runner: machineRecord },
    });
  });

  it("reads records from before machines with no label or weight", () => {
    const { label: _l, weight: _w, ...old } = machineRecord;
    expect(RunnerRecord.parse({ ...old, backend: "docker" })).toMatchObject({
      label: null,
      weight: null,
    });
  });

  it("round-trips the API shapes", () => {
    roundTrip(Machine, machine);
    roundTrip(MachinesResponse, { machines: [machine], command: "npx -y codeden@0.7.10" });
    roundTrip(AddMachineRequest, { destination: "dev@vps-1", name: "vps-1" });
  });

  it("accepts what ssh accepts as a destination, and nothing it could read as an option", () => {
    for (const ok of [
      "vps-1",
      "dev@vps-1",
      "dev@100.64.0.2",
      "ssh://dev@vps:2222",
      "box.tail1.ts.net",
    ]) {
      expect(SshDestination.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["", "-oProxyCommand=x", "a b", "a;b", "$(id)", "a`b`", "a\nb", "x'y"]) {
      expect(SshDestination.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("keeps labels short and away from the reserved placements", () => {
    expect(MachineLabel.safeParse("vps-1").success).toBe(true);
    expect(MachineLabel.safeParse("Home").success).toBe(false);
    expect(MachineLabel.safeParse("auto").success).toBe(false);
    expect(MachineLabel.safeParse("a/b").success).toBe(false);
    expect(SessionPlacement.parse("home")).toBe("home");
    expect(SessionPlacement.parse("vps-1")).toBe("vps-1");
  });

  it("offers the four preferences, Normal by default", () => {
    expect(MACHINE_PREFERENCES.map((p) => p.weight)).toEqual([100, 50, 25, 0]);
    expect(MachineWeight.safeParse(75).success).toBe(false);
  });

  it("places a project or one session on a machine", () => {
    const project = roundTrip(Project, {
      ...sampleProject,
      execution: { backend: "ssh", machine: "vps-1" },
    });
    expect(project.execution).toEqual({ backend: "ssh", machine: "vps-1" });
    expect(
      UpdateProjectRequest.parse({ execution: { backend: "ssh", machine: "vps-1" } }).execution,
    ).toEqual({ backend: "ssh", machine: "vps-1" });
    const req = roundTrip(StartSessionRequest, { projectId: "p1", machine: "vps-1" });
    expect(req.machine).toBe("vps-1");
    expect(StartSessionRequest.safeParse({ projectId: "p1", machine: "a b" }).success).toBe(false);
  });
});

describe("per-project clones on a machine (A2)", () => {
  const prepare = {
    name: "workspace.prepare",
    sessionId: "s1",
    strategy: "clone",
    remoteUrl: "https://github.com/o/r.git",
    perProject: true,
    projectSlug: "demo",
  };

  it("round-trips the command and a result naming the project's clone", () => {
    roundTrip(RunnerCommand, prepare);
    roundTrip(RunnerCommandResults["workspace.prepare"], {
      cwd: "/home/dev/.codeden-runner/wt/demo/s1",
      branch: "codeden/x",
      created: true,
      repoPath: "/home/dev/.codeden-runner/repos/demo",
    });
  });

  it("needs the project's slug to name the clone", () => {
    const { projectSlug: _s, ...noSlug } = prepare;
    expect(RunnerCommand.safeParse(noSlug).success).toBe(false);
  });
});
