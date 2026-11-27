import { describe, expect, it } from "vitest";
import {
  AddMachineRequest,
  ConnectCodeResponse,
  ConnectCodeStatus,
  ConnectFile,
  CreateConnectCodeRequest,
  EventEnvelope,
  HostResources,
  MACHINE_PREFERENCES,
  Machine,
  MachineLabel,
  MachinesResponse,
  MachineWeight,
  PairRequest,
  PairResponse,
  Project,
  RunnerCommand,
  RunnerCommandResults,
  RunnerRecord,
  Session,
  SessionPlacement,
  SshDestination,
  StartSessionRequest,
  UpdateProjectRequest,
} from "../src";
import { sampleProject, sampleSession, ts } from "./fixtures";

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
  ownerMemberId: null,
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
  kind: "ssh",
  owner: null,
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
  resources: null,
  reinstalled: false,
};

const resources = {
  cpuCount: 2,
  cpuBusy: 0.25,
  totalMemoryBytes: 4 * 1024 ** 3,
  availableMemoryBytes: 2 * 1024 ** 3,
  sampledAt: ts,
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
    roundTrip(MachinesResponse, {
      machines: [{ ...machine, resources }],
      homeWeight: 100,
      homeResources: resources,
      command: "npx -y codeden@0.7.10",
    });
    expect(MachinesResponse.parse({ machines: [], command: "x" })).toMatchObject({
      homeWeight: 50,
      homeResources: null,
    });
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
    expect(SessionPlacement.parse("auto")).toBe("auto");
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

describe("automatic placement (A3)", () => {
  it("round-trips host.resources and refuses a busy share above 1", () => {
    roundTrip(RunnerCommand, { name: "host.resources" });
    roundTrip(RunnerCommandResults["host.resources"], resources);
    expect(
      RunnerCommandResults["host.resources"].safeParse({ ...resources, cpuBusy: 1.2 }).success,
    ).toBe(false);
    expect(HostResources.safeParse({ ...resources, cpuCount: 1.5 }).success).toBe(true);
  });

  it("sets Automatic on a project, and notes a fallback on the session", () => {
    expect(
      roundTrip(Project, { ...sampleProject, execution: { backend: "ssh", machine: "auto" } })
        .execution,
    ).toEqual({ backend: "ssh", machine: "auto" });
    const note = "Automatic placement found no free machine (All machines are busy); ran on Home";
    expect(roundTrip(Session, { ...sampleSession, placementNote: note }).placementNote).toBe(note);
    expect(Session.parse(sampleSession).placementNote).toBeUndefined();
  });
});

describe("connecting your own computer (D3)", () => {
  it("round-trips a personal machine and its runner record, with older ones as ssh", () => {
    const laptop = { ...machineRecord, backend: "connected", ownerMemberId: "alice" };
    expect(roundTrip(RunnerRecord, laptop).ownerMemberId).toBe("alice");
    const { ownerMemberId: _o, ...older } = machineRecord;
    expect(RunnerRecord.parse(older).ownerMemberId).toBeNull();
    const machine = MachinesResponse.parse({
      machines: [
        {
          id: "c-1",
          label: "alice-mbp",
          kind: "connected",
          owner: { id: "alice", name: "Alice" },
          destination: "alice-mbp.local",
          weight: 50,
          state: "connected",
          version: "0.7.10",
          platform: "darwin",
          arch: "arm64",
          lastError: null,
          lastSeenAt: null,
          sessions: 0,
          providers: [],
        },
      ],
      command: "npx -y codeden@0.7.10",
    }).machines[0];
    expect(roundTrip(Machine, machine)).toMatchObject({
      kind: "connected",
      owner: { name: "Alice" },
    });
  });

  it("takes only a plain server address, without its trailing slash", () => {
    expect(CreateConnectCodeRequest.parse({ serverUrl: "https://team.example.com/" })).toEqual({
      serverUrl: "https://team.example.com",
    });
    for (const bad of ["ftp://x", "https://u:p@x", "https://x/path", "https://x?q=1", "x"]) {
      expect(CreateConnectCodeRequest.safeParse({ serverUrl: bad }).success).toBe(false);
    }
  });

  it("round-trips pairing", () => {
    roundTrip(ConnectCodeResponse, {
      id: "k-1",
      code: "cdp_abc",
      expiresAt: ts,
      command: "npx -y codeden@0.7.10 connect https://x --code cdp_abc",
    });
    roundTrip(ConnectCodeStatus, { state: "paired", machineId: "c-1" });
    expect(roundTrip(PairRequest, { code: "cdp_abc" }).hostname).toBe("");
    roundTrip(PairRequest, { code: "cdp_abc", hostname: "mbp", previousMachineId: "c-1" });
    expect(roundTrip(PairResponse, { machineId: "c-1", label: "mbp", key: "cdk_k" }).fake).toBe(
      false,
    );
    const file = {
      server: "https://x",
      machineId: "c-1",
      label: "mbp",
      key: "cdk_k",
      pairedAt: ts,
    };
    expect(roundTrip(ConnectFile, file).fake).toBe(false);
    expect(ConnectFile.safeParse({ ...file, key: "cda_agent" }).success).toBe(false);
  });
});
