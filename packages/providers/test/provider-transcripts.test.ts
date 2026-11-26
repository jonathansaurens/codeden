import { describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { asksAtEveryLevel, touchesCodeden } from "../src/policy/assessment";
import { classifyCommand, classifyRead, type RiskContext } from "../src/policy/risk";

/**
 * The agent CLIs keep every conversation they ran as plain files in the user's home: on a team's
 * server, other people's orchestrators and hidden projects' sessions. Reading them asks at every
 * level and is refused for read-only sessions, like CodeDen's own home. Fixture paths only.
 */
const ctx: RiskContext = {
  cwd: "/home/me/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  env: { CODEX_HOME: "/srv/codex" },
  notesRoots: ["/home/me/.claude/projects/-home-me-work-repo/memory"],
};

const STORES = [
  "~/.claude/projects/-home-me-other/1234.jsonl",
  "/home/me/.claude/projects",
  "~/.claude/history.jsonl",
  "$CLAUDE_CONFIG_DIR/projects/x/y.jsonl",
  "~/.codex/sessions/2026/11/26/rollout.jsonl",
  "/srv/codex/sessions/2026",
  "$CODEX_HOME/archived_sessions/a.jsonl",
  "~/.codex/history.jsonl",
  "~/.local/share/opencode/storage/session/x.json",
  "~/.cursor/chats/abc/store.db",
  "~/.gemini/tmp/abc/chats/session.json",
  "~/.claude/projects/*/*.jsonl",
  "~/.codex/se*",
];

describe("agent CLIs' transcripts (§15)", () => {
  it("asks at every level for reading one, by path, shell or wildcard", () => {
    for (const target of STORES) {
      const read = classifyRead(target, ctx);
      expect(read.risky && touchesCodeden(read), target).toBe(true);
      expect(asksAtEveryLevel(classifyCommand(`cat ${target}`, ctx)), target).toBe(true);
    }
    expect(asksAtEveryLevel(classifyCommand("grep -r secret ~/.claude/projects", ctx))).toBe(true);
    expect(asksAtEveryLevel(classifyCommand("tar czf x.tgz ~/.codex/sessions", ctx))).toBe(true);
  });

  it("leaves settings, the session's own memory and other files alone", () => {
    for (const target of [
      "~/.claude/settings.json",
      "~/.codex/config.toml",
      "/home/me/.claude/projects/-home-me-work-repo/memory/MEMORY.md",
      "src/projects/list.ts",
      "~/work/sessions/notes.md",
    ]) {
      expect(classifyRead(target, ctx).risky, target).toBe(false);
    }
  });

  it("refuses read-only sessions outright", () => {
    const policy = new ClaudePolicy("auto", ctx, true);
    const denial = policy.denial("Read", {
      file_path: "/home/me/.claude/projects/-home-me-other/1.jsonl",
    });
    expect(denial).toMatch(/transcripts and credential files are off limits/);
  });
});
