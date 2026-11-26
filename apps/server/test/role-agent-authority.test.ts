import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemberRole, Role, Session } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { sampleSession } from "./helpers";
import { type MembersEnv, seedProjects, startMembersEnv } from "./support/members-env";
import { removeTree } from "./support/remove-tree";

/**
 * `docs/machines-teams-and-agents.md` §D.2: the orchestrator's and the PMs' tools act with the
 * role of the people whose messages started the turn, by the same rules as their own requests.
 */
let env: MembersEnv | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await env?.close();
  env = undefined;
  for (const dir of dirs.splice(0)) await removeTree(dir);
});

const ORCH = "orch-1";
const PM = "pm-p1";

async function setup() {
  const e = await startMembersEnv();
  env = e;
  seedProjects(e.server, ["p1", "p2"]);
  const role = (id: string, r: "orchestrator" | "pm", projectId: string | null): Session => ({
    ...sampleSession,
    id,
    role: r,
    projectId,
    status: "idle",
  });
  e.server.store.append([
    {
      type: "session.created",
      sessionId: ORCH,
      payload: { session: role(ORCH, "orchestrator", null) },
    },
    { type: "session.created", sessionId: PM, payload: { session: role(PM, "pm", "p1") } },
  ]);
  const join = async (name: string, r: MemberRole, projectRoles: Record<string, string> = {}) => {
    await e.join(await e.invite(r, { projectRoles } as never), name);
    const member = e.server.services.members.findPersonByName(name);
    if (!member) throw new Error(`no member ${name}`);
    return member.id;
  };
  // Otto is an Operator who can't see p2; Wanda is an Owner.
  const otto = await join("Otto", "operator", { p2: "none" });
  const wanda = await join("Wanda", "owner");
  // Each person's own orchestrator (§D.1); `ORCH` is the first owner's.
  for (const [id, owner] of [
    ["orch-otto", otto],
    ["orch-wanda", wanda],
  ] as const) {
    const session = { ...role(id, "orchestrator", null), ownerMemberId: owner };
    e.server.store.append([{ type: "session.created", sessionId: id, payload: { session } }]);
  }
  const s = e.server.services;
  /** A turn of a role session, started by a person's message (or automatically, `null`). */
  const turn = (sessionId: string, memberId: string | null, viaOrchestrator = false) => {
    const session = s.sessionRepo.get(sessionId);
    if (memberId === null) return s.orchestration.authority.begin(session, {}, "codeden");
    if (viaOrchestrator) {
      return s.orchestration.authority.begin(session, { onBehalfOf: memberId }, "orchestrator");
    }
    return s.orchestration.authority.begin(
      session,
      { author: { memberId, kind: "person" } },
      "user",
    );
  };
  const call = (role: Role, sessionId: string, name: string, args: unknown) =>
    s.tools.call(name, args, {
      role,
      sessionId,
      projectId: role === "pm" ? "p1" : null,
      caller: "mcp",
      signal: new AbortController().signal,
    });
  return { e, s, otto, wanda, turn, call };
}

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "codeden-role-authority-"));
  dirs.push(dir);
  return dir;
};

const automation = {
  name: "Weekly notes",
  trigger: { type: "manual" },
  action: { type: "message_pm", message: "Write the weekly notes" },
};

describe("role agents act with their person's role (§D.2)", () => {
  it("refuses an Operator's orchestrator turn what only an Owner may do", async () => {
    const { call } = await setup();
    const created = await call("orchestrator", "orch-otto", "create_project", { path: folder() });
    expect(created.isError).toBe(true);
    expect(created.text).toContain("Only an Owner can add projects");
    expect(created.text).toContain("Otto (an Operator)");
    const updated = await call("orchestrator", "orch-otto", "update_project", {
      projectId: "p1",
      name: "Renamed",
    });
    expect(updated.isError).toBe(true);
    expect(updated.text).toContain("Only an Owner can change projects on this project");
    expect(env?.server.services.projects.get("p1").name).toBe("p1");
  });

  it("lets an Owner's orchestrator create a project, also in an automatic turn", async () => {
    const { turn, call } = await setup();
    const byOwner = await call("orchestrator", "orch-wanda", "create_project", { path: folder() });
    expect(byOwner.isError, byOwner.text).toBe(false);
    // A wake-up started the first owner's orchestrator's turn: it still acts for its person.
    turn(ORCH, null);
    const automatic = await call("orchestrator", ORCH, "create_project", { path: folder() });
    expect(automatic.isError, automatic.text).toBe(false);
  });

  it("refuses an Operator's PM turn a new automation, and allows an Owner's or an automatic one", async () => {
    const { otto, wanda, turn, call } = await setup();
    turn(PM, otto);
    const refused = await call("pm", PM, "create_automation", automation);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Only an Owner can change automations");
    const names = () => env?.server.services.automations.definitions.all().map((a) => a.name);
    expect(names()).not.toContain("Weekly notes");

    // The orchestrator passing on Otto's request carries Otto's role, not its own.
    turn(PM, otto, true);
    expect((await call("pm", PM, "create_automation", automation)).isError).toBe(true);

    turn(PM, wanda);
    const byOwner = await call("pm", PM, "create_automation", automation);
    expect(byOwner.isError, byOwner.text).toBe(false);

    // A wake-up, a notice or an automation started it: CodeDen's own turn, an Owner's.
    turn(PM, null);
    const automatic = await call("pm", PM, "create_automation", automation);
    expect(automatic.isError, automatic.text).toBe(false);
  });

  it("acts with the lowest role of everyone whose messages are in the turn", async () => {
    const { s, otto, wanda, turn, call } = await setup();
    turn(PM, wanda);
    s.orchestration.authority.steered(
      s.sessionRepo.get(PM),
      { author: { memberId: otto, kind: "person" } },
      "user",
    );
    expect((await call("pm", PM, "create_automation", automation)).isError).toBe(true);
  });

  it("shows an Operator's orchestrator only the projects they can see", async () => {
    const { call } = await setup();
    const listed = await call("orchestrator", "orch-otto", "list_projects", {});
    expect(
      (JSON.parse(listed.text) as { projects: { id: string }[] }).projects.map((p) => p.id),
    ).toEqual(["p1"]);
    const overview = await call("orchestrator", "orch-otto", "get_overview", {});
    expect(overview.text).toContain("p1");
    expect(overview.text).not.toContain("p2");
    const asked = await call("orchestrator", "orch-otto", "message_pm", {
      projectId: "p2",
      text: "hi",
    });
    expect(asked.isError).toBe(true);
    expect(asked.text).toContain("No project p2");

    const all = await call("orchestrator", "orch-wanda", "list_projects", {});
    expect(
      (JSON.parse(all.text) as { projects: { id: string }[] }).projects.map((p) => p.id).sort(),
    ).toEqual(["p1", "p2"]);
  });
});
