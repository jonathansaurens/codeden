import { describe, expect, it } from "vitest";
import { type ActivityRow, activityOf } from "../src/members/activity";

const olga = { memberId: "m-olga", kind: "person" as const };
const bot = { memberId: "m-bot", kind: "agent" as const };
let seq = 100;
const row = (type: string, actor = olga, sessionId: string | null = "s1", payload: unknown = {}) =>
  ({ seq: seq--, type, actor, sessionId, ts: "2026-11-26T08:00:00.000Z", payload }) as ActivityRow;
const session = (status: string, stoppedBy: typeof olga | null = null) => ({
  session: { status, stoppedBy },
});

describe("the activity list (§B.4)", () => {
  it("keeps what people chose to do and folds what it set off", () => {
    // Newest first, as the route reads them.
    const rows = [
      row("session.updated", olga, "s1", session("stopped", olga)),
      row("session.updated", olga, "s1", session("idle")),
      row("session.updated", bot, "s2", session("running")),
      row("session.updated", olga, "s1", session("running")),
      row("session.created", olga, "s1"),
      row("settings.updated", olga, null),
      row("settings.updated", olga, null),
    ];
    expect(activityOf(rows, 100).map((e) => [e.type, e.actor.memberId])).toEqual([
      ["session.stopped", "m-olga"],
      ["turn.started", "m-bot"],
      ["session.created", "m-olga"],
      ["settings.updated", "m-olga"],
    ]);
  });

  it("doesn't call a stop by someone else this actor's", () => {
    const rows = [row("session.updated", bot, "s1", session("stopped", olga))];
    expect(activityOf(rows, 100)).toEqual([]);
  });

  it("stops at the limit", () => {
    const rows = [row("member.created", olga, null), row("project.created", olga, null)];
    expect(activityOf(rows, 1)).toHaveLength(1);
  });
});
