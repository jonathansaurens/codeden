import type { MeResponse } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRateLimiter } from "../src/members/rate-limit";
import { jsonInit, type MembersEnv, seedProjects, startMembersEnv } from "./support/members-env";

let env: MembersEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const approve = { requestId: "r1", response: { kind: "approval", decision: "allow_once" } };
const answer = { requestId: "r2", response: { kind: "answer", answers: { q: ["yes"] } } };

describe("connected agents (§C.1, §C.3)", () => {
  it("signs in with a bearer token as the agent, from another device or this machine", async () => {
    env = await startMembersEnv();
    const bot = await env.agent({ name: "Release bot", role: "operator" });
    for (const res of [
      await env.remote("/api/members/me", { as: bot.as }),
      await env.local("/api/members/me", {
        headers: { authorization: `Bearer ${(bot.as as { bearer: string }).bearer}` },
      }),
    ]) {
      expect(res.status).toBe(200);
      const me = (await res.json()) as MeResponse;
      // Even on this machine the agent acts as itself, never as the owner.
      expect(me.member).toMatchObject({ id: bot.id, kind: "agent", role: "operator" });
    }
  });

  it("never makes an agent an owner", async () => {
    env = await startMembersEnv();
    const refused = await env.local(
      "/api/members/agents",
      jsonInit("POST", { name: "x", role: "owner" }),
    );
    expect(refused.status).toBe(400);
    const bot = await env.agent({ name: "bot", role: "viewer" });
    expect(
      (await env.local(`/api/members/${bot.id}`, jsonInit("PATCH", { role: "owner" }))).status,
    ).toBe(400);
    expect(
      (
        await env.local(
          `/api/members/${bot.id}`,
          jsonInit("PATCH", { projectRoles: { p1: "owner" } }),
        )
      ).status,
    ).toBe(400);
  });

  it("refuses a Viewer agent every Operator and Owner action", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const bot = await env.agent({ name: "watcher", role: "viewer" });
    expect((await env.remote("/api/sessions/s-p1", { as: bot.as })).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", "/api/sessions/s-p1/messages", { input: { text: "hi" } }],
      ["POST", "/api/sessions/s-p1/stop", {}],
      ["POST", "/api/sessions", { projectId: "p1", prompt: "go" }],
      ["POST", "/api/sessions/s-p1/respond", answer],
      ["POST", "/api/orchestration/orchestrator/messages", { input: { text: "hi" } }],
      ["PATCH", "/api/settings", {}],
      ["POST", "/api/members/invites", { role: "viewer" }],
      ["POST", "/api/members/agents", { name: "y", role: "operator" }],
      ["PUT", "/api/secrets/x", { value: "y" }],
    ] as const) {
      const res = await env.remote(path, { ...jsonInit(method, body), as: bot.as });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("answers questions, and approvals only with May answer approvals", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const bot = await env.agent({ name: "helper", role: "operator" });
    const off = await env.remote("/api/sessions/s-p1/respond", {
      ...jsonInit("POST", approve),
      as: bot.as,
    });
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ error: { code: "approvals_not_allowed" } });
    // Questions are always allowed (this one has no runner to reach, but passes the checks).
    const question = await env.remote("/api/sessions/s-p1/respond", {
      ...jsonInit("POST", answer),
      as: bot.as,
    });
    expect(question.status).not.toBe(403);

    await env.local(`/api/members/${bot.id}`, jsonInit("PATCH", { mayAnswerApprovals: true }));
    const on = await env.remote("/api/sessions/s-p1/respond", {
      ...jsonInit("POST", approve),
      as: bot.as,
    });
    expect(on.status).not.toBe(403);
  });

  it("refuses revoked tokens, disabled agents and deleted agents", async () => {
    env = await startMembersEnv();
    const bot = await env.agent({ name: "bot", role: "viewer" });
    const token = (bot.as as { bearer: string }).bearer;
    // A second token; revoking the first leaves it working.
    const minted = (await (
      await env.local(`/api/members/${bot.id}/tokens`, jsonInit("POST", {}))
    ).json()) as {
      token: string;
      member: { tokens: Array<{ id: string }> };
    };
    const first = minted.member.tokens.find((t) => t.id)?.id;
    await env.local(`/api/members/${bot.id}/tokens/${first}`, { method: "DELETE" });
    const second = { bearer: minted.token };
    expect((await env.remote("/api/members/me", { as: { bearer: token } })).status).toBe(401);
    expect((await env.remote("/api/members/me", { as: second })).status).toBe(200);

    await env.local(`/api/members/${bot.id}`, jsonInit("PATCH", { disabled: true }));
    expect((await env.remote("/api/members/me", { as: second, from: "203.0.113.8" })).status).toBe(
      401,
    );
    await env.local(`/api/members/${bot.id}`, jsonInit("PATCH", { disabled: false }));
    expect((await env.remote("/api/members/me", { as: second, from: "203.0.113.8" })).status).toBe(
      200,
    );
    await env.local(`/api/members/${bot.id}`, { method: "DELETE" });
    expect((await env.remote("/api/members/me", { as: second, from: "203.0.113.9" })).status).toBe(
      401,
    );
  });

  it("never gives an agent a terminal, even as an Operator", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const bot = await env.agent({ name: "bot", role: "operator" });
    const res = await env.remote("/ws/pty?sessionId=s-p1", { as: bot.as });
    expect(res.status).toBe(403);
  });

  it("keeps agent tokens off the internal /mcp", async () => {
    env = await startMembersEnv();
    const bot = await env.agent({ name: "bot", role: "operator" });
    const token = (bot.as as { bearer: string }).bearer;
    const initialize = jsonInit("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const local = await env.local("/mcp", {
      ...initialize,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    });
    expect(local.status).toBe(401);
    const remote = await env.remote("/mcp", { ...initialize, as: bot.as });
    expect(remote.status).toBe(404);
  });

  it("throttles bad tokens per address and rate-limits good ones", async () => {
    env = await startMembersEnv({ agentRateLimit: { burst: 3, perMinute: 0 } });
    const bot = await env.agent({ name: "bot", role: "viewer" });
    const bad = { bearer: `cda_${"x".repeat(43)}` };
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (await env.remote("/api/members/me", { as: bad, from: "198.51.100.1" })).status,
      );
    }
    // Three free failures, then the address has to wait.
    expect(statuses).toEqual([401, 401, 401, 429]);
    // Another address isn't affected; the good token gets its burst, then 429.
    const good: number[] = [];
    for (let i = 0; i < 4; i++) {
      good.push((await env.remote("/api/members/me", { as: bot.as, from: "198.51.100.2" })).status);
    }
    expect(good).toEqual([200, 200, 200, 429]);
  });
});

describe("AgentRateLimiter", () => {
  it("allows a burst, then refills at the per-minute rate", () => {
    let now = 0;
    const limiter = new AgentRateLimiter(() => now, 2, 60);
    expect(limiter.take("t").allowed).toBe(true);
    expect(limiter.take("t").allowed).toBe(true);
    const refused = limiter.take("t");
    expect(refused).toEqual({ allowed: false, retryAfterMs: 1000 });
    now += 1000;
    expect(limiter.take("t").allowed).toBe(true);
    expect(limiter.take("other").allowed).toBe(true);
  });
});
