import type { Notice, Session, StartSessionRequest } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnAuthority } from "../src/services/orchestration/turn-authority";
import { sampleSession } from "./helpers";
import { jsonInit, type MembersEnv, seedProjects, startMembersEnv } from "./support/members-env";

/**
 * Work a person starts is theirs (`startedBy: { kind: "user" }` with their member id): a client
 * can't make it look like a PM's or the orchestrator's, whose results wake the PM for a turn
 * acting as an Owner, and a notice about it makes a PM turn act with no more than their role.
 */
let env: MembersEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

describe("work a person starts (§D.2)", () => {
  it("records the caller as its starter, whatever the request claims", async () => {
    const e = await startMembersEnv();
    env = e;
    const s = e.server.services;
    seedProjects(e.server, ["p1"]);
    const otto = await e.join(await e.invite("operator"), "Otto");
    const ottoId = s.members.findPersonByName("Otto")?.id;
    const start = vi
      .spyOn(s.sessions, "start")
      .mockResolvedValue({ status: "started", sessionId: "new1" } as never);
    const claim = {
      projectId: "p1",
      startedBy: { kind: "pm", reportTo: "orchestrator", reportToMembers: ["owner"] },
      parentSessionId: "s-p1",
      input: { text: "Do it", from: "pm", onBehalfOf: "owner" },
    };
    const res = await e.remote("/api/sessions", { ...jsonInit("POST", claim), as: otto });
    expect(res.status).toBe(200);
    const req = start.mock.calls[0]?.[0] as StartSessionRequest;
    expect(req.startedBy).toEqual({ kind: "user", id: ottoId });
    expect(req.parentSessionId).toBeUndefined();
    expect(req.input).toEqual({ text: "Do it", attachments: [] });

    // Only agent sessions start here.
    for (const role of ["pm", "orchestrator"]) {
      const refused = await e.remote("/api/sessions", {
        ...jsonInit("POST", { ...claim, role }),
        as: otto,
      });
      expect(refused.status, role).toBe(400);
    }
    expect(start).toHaveBeenCalledTimes(1);

    // The member tool records the same.
    const bot = await e.agent({ name: "ci-bot", role: "operator" });
    const tool = await e.remote("/api/member-tools/start_session", {
      ...jsonInit("POST", { projectId: "p1", prompt: "Go" }),
      as: bot.as,
    });
    expect(tool.status).toBe(200);
    expect((start.mock.calls[1]?.[0] as StartSessionRequest).startedBy).toEqual({
      kind: "user",
      id: bot.id,
    });
  });

  it("lets a notice about a person's session cap the PM's turn at their role", () => {
    let meta: Record<string, unknown> | null = null;
    const authority = new TurnAuthority({
      find: () => ({ startMeta: meta }) as never,
      setStartMeta: (_id: string, f: (m: never) => unknown) => {
        meta = f(meta as never) as Record<string, unknown>;
      },
    } as never);
    const pm: Session = { ...sampleSession, id: "pm1", role: "pm", projectId: "p1" };
    const finished = (startedBy: Record<string, unknown>) =>
      ({
        id: `n-${String(startedBy.kind)}`,
        type: "session.finished",
        projectId: "p1",
        target: "pm",
        data: { sessionId: "ag1", workKey: "request:x", purpose: "x", startedBy },
      }) as unknown as Notice;
    // A wake with only a PM's work: automatic, as before.
    authority.begin(pm, {}, "codeden").carry([finished({ kind: "pm" })]);
    expect(authority.of(pm.id).members).toEqual([]);
    // A wake that carries Otto's session's result acts for Otto.
    authority.begin(pm, {}, "codeden").carry([finished({ kind: "user", id: "otto" })]);
    expect(authority.of(pm.id).members).toEqual(["otto"]);
  });
});
