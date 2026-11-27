import type { RoleSessionResponse, Session, Snapshot } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { canWatchSession, eventFilterFor } from "../src/members/sockets";
import { sampleSession } from "./helpers";
import {
  type Credential,
  jsonInit,
  type MembersEnv,
  seedProjects,
  startMembersEnv,
} from "./support/members-env";

/**
 * `docs/machines-teams-and-agents.md` §D.1 and §D.3: every person has an orchestrator of their
 * own, which nobody else reads, and PMs report back to the orchestrator that asked.
 */
let env: MembersEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
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
  return { e, s: e.server.services, otto, wanda };
}

/** The caller's own orchestrator, created when missing. */
async function orchestratorOf(e: MembersEnv, as: Credential | null): Promise<Session> {
  const init = jsonInit("POST", {});
  const res = as
    ? await e.remote("/api/orchestration/orchestrator", { ...init, as })
    : await e.local("/api/orchestration/orchestrator", init);
  expect(res.status).toBe(200);
  const body = (await res.json()) as RoleSessionResponse;
  if (!body.session) throw new Error("no orchestrator");
  return body.session;
}

const snapshotOf = async (e: MembersEnv, as: Credential | null) =>
  (await (as
    ? await e.remote("/api/snapshot", { as })
    : await e.local("/api/snapshot")
  ).json()) as Snapshot;

const orchestratorIds = (snapshot: Snapshot) =>
  snapshot.sessions.filter((x) => x.role === "orchestrator").map((x) => x.id);

describe("a personal orchestrator for each person (§D.1)", () => {
  it("gives each person their own orchestrator, which nobody else can read", async () => {
    const { e, s, otto, wanda } = await setup();
    const mine = await orchestratorOf(e, null);
    const ottos = await orchestratorOf(e, otto.as);
    const wandas = await orchestratorOf(e, wanda.as);
    expect(new Set([mine.id, ottos.id, wandas.id]).size).toBe(3);
    expect(ottos.ownerMemberId).toBe(otto.id);
    expect(wandas.ownerMemberId).toBe(wanda.id);
    // The same one again on the next call.
    expect((await orchestratorOf(e, otto.as)).id).toBe(ottos.id);

    // Not even an Owner reads another person's.
    for (const path of [`/api/sessions/${ottos.id}`, `/api/sessions/${ottos.id}/snapshot`]) {
      expect((await e.remote(path, { as: wanda.as })).status, path).toBe(404);
      expect((await e.local(path)).status, path).toBe(404);
    }
    expect((await e.remote(`/api/sessions/${wandas.id}`, { as: otto.as })).status).toBe(404);
    expect((await e.remote(`/api/sessions/${ottos.id}`, { as: otto.as })).status).toBe(200);
    const send = jsonInit("POST", { input: { text: "hi" } });
    expect(
      (await e.remote(`/api/sessions/${wandas.id}/messages`, { ...send, as: otto.as })).status,
    ).toBe(404);

    const ottoSees = await snapshotOf(e, otto.as);
    expect(orchestratorIds(ottoSees)).toEqual([ottos.id]);
    expect(ottoSees.roleSessions?.orchestrator).toBe(ottos.id);
    const wandaSees = await snapshotOf(e, wanda.as);
    expect(orchestratorIds(wandaSees)).toEqual([wandas.id]);
    expect(wandaSees.roleSessions?.orchestrator).toBe(wandas.id);
    const ownerSees = await snapshotOf(e, null);
    expect(orchestratorIds(ownerSees)).toEqual([mine.id]);
    expect(ownerSees.roleSessions?.orchestrator).toBe(mine.id);
    const listed = (await (await e.remote("/api/sessions", { as: wanda.as })).json()) as Session[];
    expect(listed.map((x) => x.id)).not.toContain(ottos.id);

    // The live streams: no transcript, no events of someone else's orchestrator.
    const asWanda = { member: s.members.get(wanda.id), via: "session" as const };
    expect(canWatchSession(s, asWanda, ottos.id)).toBe(false);
    expect(canWatchSession(s, asWanda, wandas.id)).toBe(true);
    const filter = eventFilterFor(s, asWanda);
    const event = (sessionId: string) =>
      ({ seq: 1, type: "agent.turn.started", sessionId, ts: "", payload: {} }) as never;
    expect(filter?.(event(ottos.id))).toBe(false);
    expect(filter?.(event(wandas.id))).toBe(true);
  });

  it("routes a PM's answer to the orchestrator that asked, and other reports to Owners", async () => {
    const { e, s, otto, wanda } = await setup();
    const pm: Session = { ...sampleSession, id: "pm-p1", role: "pm", projectId: "p1" };
    e.server.store.append([
      { type: "session.created", sessionId: pm.id, payload: { session: pm } },
    ]);
    const wandas = await orchestratorOf(e, wanda.as);
    const waiting = (memberId: string | null) =>
      s.orchestration.notices
        .undelivered("orchestrator", null, memberId)
        .filter((n) => n.type === "pm.message");

    // Wanda's orchestrator asked; the answer arrives after the call gave up.
    s.orchestration.asks.register(
      "a1b2c3d4",
      { pmSessionId: pm.id, projectId: "p1", fromSessionId: wandas.id },
      { detached: true },
    );
    expect(s.orchestration.asks.answer("a1b2c3d4", "Done")).toBe(true);
    await expect.poll(() => waiting(wanda.id).length).toBe(1);
    expect(waiting(otto.id)).toHaveLength(0);
    expect(waiting(null)).toHaveLength(0);

    // A report in a turn Otto's orchestrator started goes back to Otto's.
    s.orchestration.authority.begin(pm, { onBehalfOf: otto.id }, "orchestrator");
    s.orchestration.messageOrchestrator(pm, "Started on it", { informational: false });
    expect(waiting(otto.id)).toHaveLength(1);
    expect(waiting(wanda.id)).toHaveLength(1);

    // Unprompted: the project's Owners (Wanda and the first owner), not Otto.
    s.orchestration.authority.begin(pm, {}, "codeden");
    s.orchestration.messageOrchestrator(pm, "CI is red", { informational: false });
    expect(waiting(wanda.id)).toHaveLength(2);
    expect(waiting(null)).toHaveLength(1);
    expect(waiting(otto.id)).toHaveLength(1);
  });

  it("gives connected agents no orchestrator", async () => {
    const { e } = await setup();
    const bot = await e.agent({ name: "ci-bot", role: "operator" });
    await orchestratorOf(e, null);
    const send = jsonInit("POST", { input: { text: "hi" } });
    const res = await e.remote("/api/orchestration/orchestrator/messages", { ...send, as: bot.as });
    expect(res.status).toBe(403);
    const got = await e.remote("/api/orchestration/orchestrator", { as: bot.as });
    expect(((await got.json()) as RoleSessionResponse).session).toBeNull();
    const snapshot = await snapshotOf(e, bot.as);
    expect(orchestratorIds(snapshot)).toEqual([]);
    expect(snapshot.roleSessions?.orchestrator).toBeNull();
    const tools = (await (await e.remote("/api/member-tools", { as: bot.as })).json()) as {
      tools: { name: string }[];
    };
    expect(tools.tools.map((t) => t.name)).not.toContain("message_orchestrator");
  });

  it("retires a deleted member's orchestrator", async () => {
    const { e, s, otto } = await setup();
    const ottos = await orchestratorOf(e, otto.as);
    expect((await e.local(`/api/members/${otto.id}`, { method: "DELETE" })).status).toBe(200);
    await expect
      .poll(() => s.sessionRepo.get(ottos.id).archivedAt, { timeout: 20_000 })
      .not.toBeNull();
    expect(s.orchestration.roles.find("orchestrator", otto.id)).toBeUndefined();
  });

  it("keeps a single-user install's orchestrator as it was", async () => {
    const e = await startMembersEnv();
    env = e;
    const session = await orchestratorOf(e, null);
    expect(session.ownerMemberId).toBeUndefined();
    expect(session.workKey).toBe("orchestrator:main");
    expect((await snapshotOf(e, null)).roleSessions?.orchestrator).toBe(session.id);
    expect((await e.local(`/api/sessions/${session.id}`)).status).toBe(200);
  });
});
