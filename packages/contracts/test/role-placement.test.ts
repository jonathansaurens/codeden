import { describe, expect, it } from "vitest";
import {
  Project,
  ROLE_ON_SERVER,
  RolePlacementData,
  RunnerCommand,
  RunsOnResponse,
  SetRunsOnRequest,
  UpdateProjectRequest,
} from "../src";
import { sampleProject } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

describe("where the orchestrator and PMs run (§D.4)", () => {
  it("defaults a project's PM to the server, and keeps a machine id", () => {
    const { pmRunsOn: _, ...older } = sampleProject;
    expect(Project.parse(older).pmRunsOn).toBe(ROLE_ON_SERVER);
    expect(roundTrip(Project, { ...sampleProject, pmRunsOn: "m-vps1" }).pmRunsOn).toBe("m-vps1");
    expect(UpdateProjectRequest.parse({ pmRunsOn: "server" })).toEqual({ pmRunsOn: "server" });
    expect(UpdateProjectRequest.safeParse({ pmRunsOn: "" }).success).toBe(false);
  });

  it("round-trips the orchestrator's setting and its choices", () => {
    expect(roundTrip(SetRunsOnRequest, { runsOn: "m-vps1" })).toEqual({ runsOn: "m-vps1" });
    const response = roundTrip(RunsOnResponse, {
      runsOn: "server",
      choices: [
        { id: "server", label: "The server", state: "connected", ready: true, reason: null },
        {
          id: "m-laptop",
          label: "laptop",
          state: "disconnected",
          ready: false,
          reason: "laptop is offline",
          owner: { id: "mem-1", name: "Ann" },
        },
      ],
    });
    expect(response.choices[0]?.owner).toBeNull();
    expect(
      roundTrip(RolePlacementData, { reason: "fallback", from: "m-vps1", to: "server" }),
    ).toEqual({ reason: "fallback", from: "m-vps1", to: "server" });
  });

  it("checks the role workspaces a runner prepares", () => {
    const base = { name: "workspace.prepare", sessionId: "s-1", setupCommands: [] };
    const folder = roundTrip(RunnerCommand, {
      ...base,
      strategy: "folder",
      folder: "orchestrator/mem-1",
    });
    expect(folder).toMatchObject({ strategy: "folder", folder: "orchestrator/mem-1" });
    for (const bad of ["../x", "orchestrator/../..", "/abs", ".hidden", "a//b"]) {
      expect(RunnerCommand.safeParse({ ...base, strategy: "folder", folder: bad }).success).toBe(
        false,
      );
    }
    expect(RunnerCommand.safeParse({ ...base, strategy: "folder" }).success).toBe(false);
    const clone = {
      ...base,
      strategy: "clone",
      remoteUrl: "https://github.com/o/r.git",
      projectSlug: "r",
      projectRoot: true,
    };
    expect(RunnerCommand.safeParse(clone).success).toBe(false);
    expect(roundTrip(RunnerCommand, { ...clone, perProject: true })).toMatchObject({
      projectRoot: true,
    });
  });
});
