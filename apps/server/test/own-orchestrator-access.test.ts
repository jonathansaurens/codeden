import type { RoleSessionResponse, RoleSessionsRef, Session, Snapshot } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canWatchSession, eventFilterFor } from "../src/members/sockets";
import {
  type Credential,
  jsonInit,
  type MembersEnv,
  seedProjects,
  startMembersEnv,
} from "./support/members-env";

/**
 * A person's own orchestrator belongs to no project, so it is checked with their `own` role (the
 * highest anywhere, §D.1): a member with a hidden project still reads and drives their own.
 */
let env: MembersEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

async function orchestratorOf(e: MembersEnv, as: Credential): Promise<Session> {
  const res = await e.remote("/api/orchestration/orchestrator", { ...jsonInit("POST", {}), as });
  const body = (await res.json()) as RoleSessionResponse;
  if (!body.session) throw new Error("no orchestrator");
  return body.session;
}

describe("your own orchestrator with a hidden project (§D.1)", () => {
  it("reads and acts on it with the highest role, and still hides others'", async () => {
    const e = await startMembersEnv();
    env = e;
    const s = e.server.services;
    seedProjects(e.server, ["p1", "p2"]);
    const otto = await e.join(await e.invite("operator", { projectRoles: { p2: "none" } }), "Otto");
    const vera = await e.join(await e.invite("viewer", { projectRoles: { p2: "none" } }), "Vera");
    const wanda = await e.join(await e.invite("owner"), "Wanda");
    const ottos = await orchestratorOf(e, otto);
    const wandas = await orchestratorOf(e, wanda);

    for (const path of [
      `/api/sessions/${ottos.id}`,
      `/api/sessions/${ottos.id}/snapshot`,
      "/api/orchestration/roles",
      "/api/orchestration/notices",
    ]) {
      expect((await e.remote(path, { as: otto })).status, path).toBe(200);
    }
    const roles = (await (
      await e.remote("/api/orchestration/roles", { as: otto })
    ).json()) as RoleSessionsRef;
    expect(roles.orchestrator).toBe(ottos.id);
    const snapshot = (await (await e.remote("/api/snapshot", { as: otto })).json()) as Snapshot;
    expect(snapshot.sessions.map((x) => x.id)).toContain(ottos.id);
    expect(snapshot.projects.map((p) => p.id)).toEqual(["p1"]);

    // Acting on it: an Operator somewhere is an Operator on their own orchestrator.
    vi.spyOn(s.sessions, "interrupt").mockResolvedValue();
    const interrupt = jsonInit("POST", {});
    expect(
      (await e.remote(`/api/sessions/${ottos.id}/interrupt`, { ...interrupt, as: otto })).status,
    ).toBe(200);
    // Someone else's stays out of reach.
    expect((await e.remote(`/api/sessions/${wandas.id}/snapshot`, { as: otto })).status).toBe(404);

    // A Viewer reads theirs but doesn't act on it.
    expect((await e.remote("/api/orchestration/orchestrator", { as: vera })).status).toBe(200);
    const start = await e.remote("/api/orchestration/orchestrator", {
      ...jsonInit("POST", {}),
      as: vera,
    });
    expect(start.status).toBe(403);

    // The live streams.
    const ottoId = s.members.findPersonByName("Otto")?.id ?? "";
    const asOtto = { member: s.members.get(ottoId), via: "session" as const };
    expect(canWatchSession(s, asOtto, ottos.id)).toBe(true);
    expect(canWatchSession(s, asOtto, wandas.id)).toBe(false);
    const filter = eventFilterFor(s, asOtto);
    const event = (sessionId: string) =>
      ({ seq: 1, type: "agent.turn.started", sessionId, ts: "", payload: {} }) as never;
    expect(filter?.(event(ottos.id))).toBe(true);
    expect(filter?.(event(wandas.id))).toBe(false);
    expect(filter?.(event("s-p2"))).toBe(false);
  });
});
