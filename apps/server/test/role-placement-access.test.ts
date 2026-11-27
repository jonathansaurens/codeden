import type { NewEvent, RunnerRecord, RunsOnResponse } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { jsonInit, type MembersEnv, seedProjects, startMembersEnv } from "./support/members-env";

/**
 * Who may choose where a role runs (`docs/machines-teams-and-agents.md` §D.4): a person their own
 * orchestrator's, among the server and the machines they may use (someone else's own computer is
 * neither listed nor accepted); only an Owner a project's PM's.
 */
let env: MembersEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const at = "2026-11-26T09:00:00.000Z";
const record = (id: string, label: string, ownerMemberId: string | null): RunnerRecord => ({
  id,
  backend: ownerMemberId ? "connected" : "ssh",
  home: false,
  runnerId: `r-${id}`,
  sandboxRef: ownerMemberId ? null : `dev@${label}`,
  label,
  weight: null,
  ownerMemberId,
  projectId: null,
  sessionId: null,
  state: "disconnected",
  version: null,
  imageVersion: null,
  createdAt: at,
  lastSeenAt: null,
  lastError: null,
});

async function setup() {
  const e = await startMembersEnv();
  env = e;
  seedProjects(e.server, ["p1"]);
  const join = async (name: string, role: "operator" | "owner") => {
    const as = await e.join(await e.invite(role), name);
    const member = e.server.services.members.findPersonByName(name);
    if (!member) throw new Error(`no member ${name}`);
    return { as, id: member.id };
  };
  const otto = await join("Otto", "operator");
  const wanda = await join("Wanda", "owner");
  e.server.store.append(
    [
      record("m-vps", "vps-1", null),
      record("m-otto", "otto-mbp", otto.id),
      record("m-wanda", "wanda-mbp", wanda.id),
    ].map(
      (runner): NewEvent => ({ type: "runner.registered", sessionId: null, payload: { runner } }),
    ),
  );
  return { e, otto, wanda };
}

describe("choosing Runs on (§D.4)", () => {
  it("offers a person the server, shared machines and their own computer only", async () => {
    const { e, otto } = await setup();
    const listed = await e.remote("/api/orchestration/orchestrator/runs-on", { as: otto.as });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as RunsOnResponse;
    expect(body.runsOn).toBe("server");
    expect(body.choices.map((c) => c.id)).toEqual(["server", "m-vps", "m-otto"]);
    expect(body.choices.find((c) => c.id === "m-otto")?.owner?.id).toBe(otto.id);

    const mine = await e.remote("/api/orchestration/orchestrator/runs-on", {
      ...jsonInit("PUT", { runsOn: "m-otto" }),
      as: otto.as,
    });
    expect(mine.status).toBe(200);
    expect(e.server.services.preferences.orchestratorRunsOn(otto.id)).toBe("m-otto");

    const theirs = await e.remote("/api/orchestration/orchestrator/runs-on", {
      ...jsonInit("PUT", { runsOn: "m-wanda" }),
      as: otto.as,
    });
    expect(theirs.status).toBe(403);
    expect(((await theirs.json()) as { error: { code: string } }).error.code).toBe(
      "machine_not_yours",
    );
    // The first owner (this machine's browser) can't pick Wanda's computer either.
    const owner = await e.local(
      "/api/orchestration/orchestrator/runs-on",
      jsonInit("PUT", { runsOn: "m-wanda" }),
    );
    expect(owner.status).toBe(403);
    expect(e.server.services.preferences.orchestratorRunsOn("owner")).toBe("server");
  });

  it("lets only an Owner choose where a project's PM runs, and never someone else's computer", async () => {
    const { e, otto, wanda } = await setup();
    // A GitHub project, so machines may take its PM.
    const p1 = e.server.services.projects.get("p1");
    e.server.store.append([
      {
        type: "project.updated",
        sessionId: null,
        payload: {
          project: {
            ...p1,
            kind: "github",
            github: {
              owner: "o",
              repo: "r",
              remoteUrl: "https://github.com/o/r.git",
              defaultBranch: "main",
            },
          },
        },
      },
    ]);
    const patch = (runsOn: string) => jsonInit("PATCH", { pmRunsOn: runsOn });
    const byOperator = await e.remote("/api/projects/p1", { ...patch("m-vps"), as: otto.as });
    expect(byOperator.status).toBe(403);
    const othersComputer = await e.remote("/api/projects/p1", {
      ...patch("m-otto"),
      as: wanda.as,
    });
    expect(othersComputer.status).toBe(403);
    const ownComputer = await e.remote("/api/projects/p1", { ...patch("m-wanda"), as: wanda.as });
    expect(ownComputer.status).toBe(200);
    expect(e.server.services.projects.get("p1").pmRunsOn).toBe("m-wanda");
    const shared = await e.remote("/api/projects/p1", { ...patch("m-vps"), as: wanda.as });
    expect(shared.status).toBe(200);
    expect(e.server.services.projects.get("p1").pmRunsOn).toBe("m-vps");
  });
});
