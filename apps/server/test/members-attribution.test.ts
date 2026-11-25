import type { InboxItem, MeResponse, QueuedMessage, RawEventEnvelope } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
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

async function memberOf(e: MembersEnv, as: Credential) {
  return ((await (await e.remote("/api/members/me", { as })).json()) as MeResponse).member;
}

function eventsOf(e: MembersEnv, type: string): RawEventEnvelope[] {
  return e.server.store.listAfter(0, 10_000).filter((x) => x.type === type);
}

const approval = (status: InboxItem["status"], resolution: InboxItem["resolution"]): InboxItem => ({
  id: "inbox:s-p1:i1",
  kind: "approval",
  status,
  priority: "normal",
  notify: "needs_you",
  title: "Run tests?",
  body: null,
  projectId: "p1",
  sessionId: "s-p1",
  threadId: null,
  itemId: "i1",
  requestId: "r1",
  issue: null,
  pr: null,
  automationRunId: null,
  createdAt: "2026-11-25T09:00:00.000Z",
  updatedAt: "2026-11-25T09:00:00.000Z",
  resolvedAt: status === "open" ? null : "2026-11-25T09:01:00.000Z",
  resolution,
});

describe("attribution and presence (§B.4)", () => {
  it("records who changed settings and who stopped a session", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const olga = await env.join(await env.invite("owner"), "Olga");
    const olgaId = (await memberOf(env, olga)).id;

    const patch = await env.remote("/api/settings", {
      ...jsonInit("PATCH", { general: { userName: "Team" } }),
      as: olga,
    });
    expect(patch.status).toBe(200);
    expect(eventsOf(env, "settings.updated").at(-1)?.actor).toEqual({
      memberId: olgaId,
      kind: "person",
    });

    const stop = await env.remote("/api/sessions/s-p1/stop", { ...jsonInit("POST", {}), as: olga });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toMatchObject({
      status: "stopped",
      stoppedBy: { memberId: olgaId, kind: "person" },
    });
    // The activity list shows it to owners.
    const activity = (await (await env.local("/api/members/activity")).json()) as {
      events: Array<{ type: string; actor: { memberId: string } }>;
    };
    expect(
      activity.events.some((e) => e.type === "settings.updated" && e.actor.memberId === olgaId),
    ).toBe(true);
  });

  it("stamps the sender on messages and never trusts one the client sends", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    env.server.store.append([
      {
        type: "session.updated",
        sessionId: "s-p1",
        payload: { session: { ...sampleSession, id: "s-p1", projectId: "p1", status: "running" } },
      },
    ]);
    const otto = await env.join(await env.invite("operator"), "Otto");
    const ottoId = (await memberOf(env, otto)).id;
    const res = await env.remote("/api/sessions/s-p1/messages", {
      ...jsonInit("POST", {
        input: { text: "please", author: { memberId: "owner", kind: "person" } },
        whenBusy: "queue",
      }),
      as: otto,
    });
    expect(res.status).toBe(200);
    const queued = eventsOf(env, "message.queued").at(-1)?.payload as { message: QueuedMessage };
    expect(queued.message.input.author).toEqual({ memberId: ottoId, kind: "person" });
  });

  it("lets the first answer win and tells the second who answered", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const ana = await env.join(await env.invite("operator"), "Ana");
    const bob = await env.join(await env.invite("operator"), "Bob");
    const anaId = (await memberOf(env, ana)).id;
    // Ana's answer went first (an open approval would start CodeDen's unwatched-approval timer).
    env.server.store.append([
      {
        type: "inbox.created",
        sessionId: "s-p1",
        payload: {
          item: approval("resolved", {
            decision: "allow_once",
            answeredBy: { memberId: anaId, kind: "person" },
          }),
        },
      },
    ]);
    const response = { kind: "approval", decision: "deny" };
    const late = await env.remote("/api/sessions/s-p1/respond", {
      ...jsonInit("POST", { requestId: "r1", response }),
      as: bob,
    });
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({
      error: { code: "already_answered", message: "Already answered by Ana." },
    });
    const viaInbox = await env.remote("/api/inbox/inbox:s-p1:i1/resolve", {
      ...jsonInit("POST", { status: "resolved", response }),
      as: bob,
    });
    expect(viaInbox.status).toBe(409);
  });

  it("shows who is looking at a session", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const ana = (await env.join(await env.invite("viewer"), "Ana")) as { cookie: string };
    const bob = (await env.join(await env.invite("viewer"), "Bob")) as { cookie: string };
    const open = (cookie: string) =>
      TestWsClient.open(env?.server.url ?? "", {
        host: TEAM_HOST,
        "x-forwarded-for": "203.0.113.7",
        cookie,
      });
    const a = await open(ana.cookie);
    const b = await open(bob.cookie);
    try {
      a.send({ type: "watch_session", sessionId: "s-p1", fromSeq: 0 });
      await a.waitFor((m) => m.type === "presence" && m.memberIds.length === 1);
      b.send({ type: "watch_session", sessionId: "s-p1", fromSeq: 0 });
      const both = await a.waitFor((m) => m.type === "presence" && m.memberIds.length === 2);
      expect(both).toMatchObject({ sessionId: "s-p1" });
      b.close();
      await a.waitFor(
        (m) =>
          m.type === "presence" &&
          m.memberIds.length === 1 &&
          a.messages.indexOf(m) > a.messages.indexOf(both),
      );
    } finally {
      a.close();
      b.close();
    }
  });
});
