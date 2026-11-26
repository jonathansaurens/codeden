import { type AgentEvent, agentEventToNewEvent } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerPort } from "../src/services/runner-port";
import {
  type Credential,
  jsonInit,
  type MembersEnv,
  seedProjects,
  startMembersEnv,
} from "./support/members-env";

let env: MembersEnv | undefined;
afterEach(async () => {
  // Inbox changes are looked at on the next tick (unwatched approvals): let that run first.
  await new Promise((resolve) => setImmediate(resolve));
  await env?.close();
  env = undefined;
});

const at = { threadId: "thread-s-p1", turnId: "t1" };
const approval = (status: "in_progress" | "completed", extra: Record<string, unknown> = {}) =>
  ({
    type: status === "in_progress" ? "item.started" : "item.completed",
    ...at,
    item: {
      id: "item-rq1",
      kind: "approval_request",
      status,
      requestId: "rq1",
      action: "command",
      title: "Run rm -rf build",
      command: "rm -rf build",
      options: ["allow_once", "allow_session", "deny"],
      ...extra,
    },
  }) as AgentEvent;

/** Session s-p1 waits on approval rq1; returns its inbox item's id. */
function pendingApproval(e: MembersEnv): string {
  const events: AgentEvent[] = [
    { type: "thread.started", thread: { id: at.threadId } },
    { type: "turn.started", ...at },
    approval("in_progress"),
  ];
  e.server.store.append(events.map((event) => agentEventToNewEvent("s-p1", event)));
  const item = e.server.services.inbox.findForRequest("s-p1", "rq1");
  if (!item) throw new Error("no inbox item");
  return item.id;
}

/** Commands the session's runner gets; it answers every one. */
function scriptedRunner(e: MembersEnv): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  const port = {
    request: async (command: Record<string, unknown>) => {
      sent.push(command);
      return {};
    },
  } as unknown as RunnerPort;
  e.server.runners.forSession = () => port;
  return sent;
}

const joined = async (e: MembersEnv, name: string): Promise<Credential> =>
  e.join(await e.invite("operator"), name);

describe("who answered (§B.4)", () => {
  it("never takes who decided an approval from the client", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const inboxId = pendingApproval(env);
    const sent = scriptedRunner(env);
    const ana = await joined(env, "Ana");
    const res = await env.remote("/api/sessions/s-p1/respond", {
      ...jsonInit("POST", {
        requestId: "rq1",
        response: { kind: "approval", decision: "allow_once", decidedBy: "policy" },
      }),
      as: ana,
    });
    expect(res.status).toBe(200);
    expect(sent[0]).toMatchObject({ response: { decidedBy: "user" } });
    expect(env.server.services.inbox.get(inboxId).resolution).toMatchObject({
      decidedBy: "user",
      answeredBy: { kind: "person" },
    });
    // The inbox route too.
    const second = scriptedRunner(env);
    env.server.store.append([
      agentEventToNewEvent("s-p1", approval("in_progress", { id: "i2", requestId: "rq2" })),
    ]);
    const item = env.server.services.inbox.findForRequest("s-p1", "rq2");
    await env.remote(`/api/inbox/${item?.id}/resolve`, {
      ...jsonInit("POST", { response: { kind: "approval", decision: "deny", decidedBy: "pm" } }),
      as: ana,
    });
    expect(second[0]).toMatchObject({ response: { decidedBy: "user" } });
  });

  it("tells the second answerer who answered through the inbox first", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const inboxId = pendingApproval(env);
    scriptedRunner(env);
    const ana = await joined(env, "Ana");
    const ben = await joined(env, "Ben");
    const dismissed = await env.remote(`/api/inbox/${inboxId}/resolve`, {
      ...jsonInit("POST", { status: "dismissed" }),
      as: ana,
    });
    expect(dismissed.status).toBe(200);
    const late = await env.remote(`/api/inbox/${inboxId}/resolve`, {
      ...jsonInit("POST", { response: { kind: "approval", decision: "allow_once" } }),
      as: ben,
    });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: { message: "Already answered by Ana." } });
  });

  it("records who answered when the agent's confirmation closed the item first", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const inboxId = pendingApproval(env);
    const e = env;
    // The runner's confirmation lands while the answer is still on its way back.
    e.server.runners.forSession = () =>
      ({
        request: async () => {
          e.server.store.append([
            agentEventToNewEvent(
              "s-p1",
              approval("completed", { decision: "allow_once", decidedBy: "user" }),
            ),
          ]);
          return {};
        },
      }) as unknown as RunnerPort;
    const ana = await joined(env, "Ana");
    const ben = await joined(env, "Ben");
    await env.remote("/api/sessions/s-p1/respond", {
      ...jsonInit("POST", {
        requestId: "rq1",
        response: { kind: "approval", decision: "allow_once" },
      }),
      as: ana,
    });
    expect(env.server.services.inbox.get(inboxId).resolution).toMatchObject({
      answeredBy: { kind: "person" },
    });
    const late = await env.remote(`/api/inbox/${inboxId}/resolve`, {
      ...jsonInit("POST", { response: { kind: "approval", decision: "deny" } }),
      as: ben,
    });
    expect(await late.json()).toMatchObject({ error: { message: "Already answered by Ana." } });
  });
});
