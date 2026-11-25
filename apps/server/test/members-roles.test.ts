import type { MeResponse, Snapshot, UiServerMessage } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { sampleSession } from "./helpers";
import {
  type Credential,
  jsonInit,
  type MembersEnv,
  seedProjects,
  startMembersEnv,
  TEAM_HOST,
} from "./support/members-env";
import { TestWsClient } from "./support/ws-client";

let env: MembersEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

/** A member who joined with an invite for `role` (and per-project roles). */
async function joined(
  e: MembersEnv,
  name: string,
  role: "viewer" | "operator" | "none",
  projectRoles: Record<string, string> = {},
): Promise<Credential> {
  return e.join(await e.invite(role, { projectRoles } as never), name);
}

/** Operator actions: messages, starting and stopping, answers, the orchestrator, automations. */
const OPERATOR_ACTIONS: Array<[string, string, unknown]> = [
  ["POST", "/api/sessions/s-p1/messages", { input: { text: "hi" } }],
  ["POST", "/api/sessions/s-p1/stop", {}],
  ["POST", "/api/sessions/s-p1/interrupt", {}],
  [
    "POST",
    "/api/sessions/s-p1/respond",
    { requestId: "r1", response: { kind: "approval", decision: "allow_once" } },
  ],
  ["POST", "/api/sessions/s-p1/archive", {}],
  ["POST", "/api/sessions/s-p1/git/push", {}],
  ["POST", "/api/sessions", { projectId: "p1", prompt: "work" }],
  ["POST", "/api/orchestration/orchestrator/messages", { input: { text: "hi" } }],
  ["POST", "/api/orchestration/projects/p1/pm/messages", { input: { text: "hi" } }],
  ["POST", "/api/automations/a1/run", {}],
  ["POST", "/api/inbox/dismiss", { ids: ["x"] }],
];

/** Owner actions: settings, members, secrets, network, projects, automations, the server. */
const OWNER_ACTIONS: Array<[string, string, unknown]> = [
  ["PATCH", "/api/settings", { general: {} }],
  ["POST", "/api/members/invites", { role: "owner" }],
  ["PATCH", "/api/members/owner", { name: "Mallory" }],
  ["PUT", "/api/secrets/github.token", { value: "x" }],
  ["PUT", "/api/network", { enabled: false }],
  ["POST", "/api/network/password", { generate: true }],
  ["DELETE", "/api/network/devices", undefined],
  ["POST", "/api/projects", { source: { type: "local", path: "/tmp" } }],
  ["PATCH", "/api/projects/p1", { name: "x" }],
  ["DELETE", "/api/projects/p1", undefined],
  ["POST", "/api/automations", { name: "x" }],
  ["PUT", "/api/agent-config/mcp", {}],
  ["GET", "/api/agent-config/mcp", undefined],
  ["GET", "/api/secrets", undefined],
  ["GET", "/api/fs/list", undefined],
  ["GET", "/api/members", undefined],
  ["POST", "/api/shutdown", {}],
];

const call = (e: MembersEnv, as: Credential, [method, path, body]: [string, string, unknown]) =>
  e.remote(path, body === undefined ? { method, as } : { ...jsonInit(method, body), as });

describe("roles on the server (§B.3)", () => {
  it("lets a Viewer watch but refuses every Operator and Owner action", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const viewer = await joined(env, "Vera", "viewer");
    expect((await env.remote("/api/snapshot", { as: viewer })).status).toBe(200);
    expect((await env.remote("/api/sessions/s-p1", { as: viewer })).status).toBe(200);
    expect((await env.remote("/api/sessions/s-p1/snapshot", { as: viewer })).status).toBe(200);
    for (const action of [...OPERATOR_ACTIONS, ...OWNER_ACTIONS]) {
      const res = await call(env, viewer, action);
      expect(res.status, `${action[0]} ${action[1]}`).toBe(403);
    }
  });

  it("lets an Operator act on work, never administer", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const operator = await joined(env, "Otto", "operator");
    for (const action of OPERATOR_ACTIONS) {
      const res = await call(env, operator, action);
      // The service may refuse (no runner, no such request), but the role check passes.
      expect([403, 401], `${action[0]} ${action[1]}`).not.toContain(res.status);
    }
    for (const action of OWNER_ACTIONS) {
      expect((await call(env, operator, action)).status, `${action[0]} ${action[1]}`).toBe(403);
    }
  });

  it("applies per-project roles and hides projects without one", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1", "p2", "p3"]);
    // Viewer everywhere, Operator on p1, nothing on p2.
    const ana = await joined(env, "Ana", "viewer", { p1: "operator", p2: "none" });

    const me = (await (await env.remote("/api/members/me", { as: ana })).json()) as MeResponse;
    expect(me.projectRoles).toEqual({ p1: "operator", p3: "viewer" });
    expect(me.globalRole).toBe("none");

    const snapshot = (await (await env.remote("/api/snapshot", { as: ana })).json()) as Snapshot;
    expect(snapshot.projects.map((p) => p.id).sort()).toEqual(["p1", "p3"]);
    expect(snapshot.sessions.map((s) => s.id).sort()).toEqual(["s-p1", "s-p3"]);
    const projects = (await (await env.remote("/api/projects", { as: ana })).json()) as Array<{
      id: string;
    }>;
    expect(projects.map((p) => p.id).sort()).toEqual(["p1", "p3"]);
    const sessions = (await (await env.remote("/api/sessions", { as: ana })).json()) as Array<{
      id: string;
    }>;
    expect(sessions.map((s) => s.id).sort()).toEqual(["s-p1", "s-p3"]);

    // The hidden project answers as if it didn't exist.
    expect((await env.remote("/api/projects/p2", { as: ana })).status).toBe(404);
    expect((await env.remote("/api/sessions/s-p2", { as: ana })).status).toBe(404);
    expect((await env.remote("/api/sessions/s-p2/snapshot", { as: ana })).status).toBe(404);
    expect((await env.remote("/api/orchestration/projects/p2/pm", { as: ana })).status).toBe(404);

    // Operator on p1 only.
    expect(
      (await env.remote("/api/sessions/s-p1/stop", { ...jsonInit("POST", {}), as: ana })).status,
    ).not.toBe(403);
    expect(
      (await env.remote("/api/sessions/s-p3/stop", { ...jsonInit("POST", {}), as: ana })).status,
    ).toBe(403);
    // Work across projects would reach p2: the orchestrator and reports are refused.
    expect((await env.remote("/api/orchestration/overview", { as: ana })).status).toBe(403);
    expect((await env.remote("/api/usage/report", { as: ana })).status).toBe(403);
  });

  it("filters the live event stream and transcripts to visible projects", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1", "p2"]);
    const ana = await joined(env, "Ana", "viewer", { p2: "none" });
    const ws = await TestWsClient.open(env.server.url, {
      host: TEAM_HOST,
      "x-forwarded-for": "203.0.113.7",
      cookie: (ana as { cookie: string }).cookie,
    });
    try {
      ws.send({ type: "subscribe", fromSeq: env.server.store.headSeq() });
      ws.send({ type: "watch_session", sessionId: "s-p2", fromSeq: 0 });
      await ws.waitFor((m) => m.type === "error");
      const update = (id: string, title: string) => ({
        type: "session.updated" as const,
        sessionId: `s-${id}`,
        payload: {
          session: {
            ...sampleSession,
            id: `s-${id}`,
            projectId: id,
            status: "idle" as const,
            title,
          },
        },
      });
      env.server.store.append([update("p2", "hidden"), update("p1", "marker")]);
      await ws.waitFor((m) => m.type === "events" && JSON.stringify(m).includes("marker"));
      const all = JSON.stringify(ws.messages);
      expect(all).not.toContain("hidden");
      expect(ws.messages.some((m: UiServerMessage) => m.type === "transcript")).toBe(false);
    } finally {
      ws.close();
    }
  });

  it("gives Viewers read-only terminals: no new shells, nothing outside a session", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const viewer = await joined(env, "Vera", "viewer");
    const status = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`${env?.server.url.replace("http", "ws")}${path}`, {
          headers: {
            host: TEAM_HOST,
            "x-forwarded-for": "203.0.113.7",
            cookie: (viewer as { cookie: string }).cookie,
          },
        });
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.once("open", () => {
          ws.close();
          resolve(101);
        });
        ws.once("error", reject);
      });
    expect(await status("/ws/pty?sessionId=s-p1")).toBe(403);
    expect(await status("/ws/pty")).toBe(403);
    expect(await status("/ws/pty?sessionId=s-p1&ptyId=pty-unknown&command=ls")).toBe(403);
    expect(await status("/ws/browser?sessionId=s-p1&open=1")).toBe(101);
  });

  it("changes nothing for the owner of a single-user install", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    for (const [method, path] of [
      ["GET", "/api/orchestration/overview"],
      ["GET", "/api/members"],
      ["GET", "/api/secrets"],
    ] as const) {
      expect((await env.local(path, { method })).status, path).toBe(200);
    }
  });
});
