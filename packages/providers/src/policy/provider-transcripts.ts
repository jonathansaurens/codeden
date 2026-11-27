import type { RiskAssessment } from "./assessment";
import { binName, unwrap } from "./command-words";
import {
  isInNotes,
  isInside,
  isWin,
  type PathContext,
  pathApi,
  resolveAgainst,
  samePath,
} from "./paths";
import { expandLocation, providerLocations } from "./provider-logins";
import { secretArgument } from "./secrets";
import { type SimpleCommand, wordPaths } from "./shell";
import { WILDCARD, wildcardReaches } from "./wildcard";

/**
 * The agent CLIs' own transcript stores (§15): every conversation each CLI ran on this machine,
 * kept as plain files in the user's home, whoever's session it was. On a server shared by a team
 * that is other people's orchestrators and the sessions of projects hidden from the reader, so
 * reading, copying or searching one (or a wildcard that reaches into one) asks at every level,
 * Full included, and read-only sessions (the orchestrator, the PMs) are refused, as for CodeDen's
 * own home. Agents learn about other sessions through CodeDen's tools, which check roles.
 *
 * - Claude Code: `projects/` (one JSONL file per conversation) and `history.jsonl` in `~/.claude`
 *   (or `CLAUDE_CONFIG_DIR`).
 * - Codex: `sessions/`, `archived_sessions/` and `history.jsonl` in `~/.codex` (or `CODEX_HOME`).
 * - OpenCode: `storage/` in its data folder (`$XDG_DATA_HOME/opencode`); its `opencode.db` is
 *   guarded as a login already.
 * - Cursor CLI: `chats/` and `projects/` in `~/.cursor` (or `CURSOR_CONFIG_DIR`).
 * - Gemini CLI: `tmp/` (its per-project chats and logs) and `history/` in `~/.gemini`.
 */

/** A verdict on another conversation's transcript: every level asks, read-only refuses. */
export function transcriptRisk(reason: string): RiskAssessment {
  return { risky: true, action: "secrets", reason, codeden: true };
}

/** The transcript stores for the context's home and environment, as absolute paths. */
export function providerTranscriptStores(ctx: PathContext): string[] {
  const at = providerLocations(ctx);
  if (!at) return [];
  const p = pathApi(ctx);
  const under = (name: string, ...names: string[][]) =>
    (at[name] ?? []).flatMap((dir) => names.map((rest) => p.join(dir, ...rest)));
  const stores = [
    ...under("CLAUDE_CONFIG_DIR", ["projects"], ["history.jsonl"]),
    ...under("CODEX_HOME", ["sessions"], ["archived_sessions"], ["history.jsonl"]),
    ...under("XDG_DATA_HOME", ["opencode", "storage"]),
    ...under("CURSOR_CONFIG_DIR", ["chats"], ["projects"]),
    ...under("GEMINI_CLI_HOME", [".gemini", "tmp"], [".gemini", "history"]),
  ];
  return stores.map((dir) => resolveAgainst(dir, ctx));
}

const slashes = (value: string) => value.replace(/\\/g, "/");

/**
 * True when `target` reaches a provider's transcripts: a path in a store (the store itself
 * included), or a wildcard that matches one or something in one (`~/.claude/projects/*`,
 * `~/.codex/se*`). `~` and the home variables resolve as in the shell; relative paths from the
 * shell's directory. The session's own notes folders (Claude's memory for its project lies in
 * `projects/`) are its own to read and write.
 */
export function touchesProviderTranscripts(target: string, ctx: PathContext): boolean {
  if (!target.trim()) return false;
  const stores = providerTranscriptStores(ctx);
  if (stores.length === 0) return false;
  const win = isWin(ctx);
  return expandLocation(target, ctx).some((value) => {
    const abs = resolveAgainst(value, ctx);
    const wild = WILDCARD.test(value);
    if (!wild && isInNotes(abs, ctx)) return false;
    if (stores.some((store) => samePath(store, abs, ctx) || isInside(abs, store, ctx))) return true;
    return wild && stores.some((s) => wildcardReaches(slashes(abs), slashes(s), win) !== false);
  });
}

/** Commands that move into, create or delete a folder: none reads what is in it. */
const NO_READ = new Set(["cd", "pushd", "chdir", "set-location", "sl", "push-location", "mkdir"]);

/**
 * One simple command's access to a provider's transcripts, read the way the secrets rules read
 * arguments (listings, data words and search patterns don't count).
 */
export function providerTranscriptCommand(
  cmd: SimpleCommand,
  ctx: PathContext,
): RiskAssessment | undefined {
  const item = cmd.reads?.find((r) => touchesProviderTranscripts(r, ctx));
  if (item) return transcriptRisk(`Reads an agent CLI's transcripts: ${item}`);
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  if (NO_READ.has(bin)) return undefined;
  const found = secretArgument(
    bin,
    tokens.slice(1),
    [],
    (path) => touchesProviderTranscripts(path, ctx),
    (word, from) => wordPaths(cmd, word, from),
  );
  return found ? transcriptRisk(`Accesses an agent CLI's transcripts: ${found}`) : undefined;
}
