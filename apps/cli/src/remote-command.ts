/**
 * `codeden --server <url> --token <token> <command> [--key value …]` (§C.2): the member tools of a
 * CodeDen server, for scripts and connected agents. Each command is a tool (`list-sessions` is
 * `list_sessions`), its flags the tool's input; `--json '{…}'` gives the whole input at once.
 * `tools` lists what the token may use. The token can also come from `CODEDEN_TOKEN`.
 * Kept free of the server code: it only speaks HTTP to `/api/member-tools`.
 */

export const REMOTE_HELP = `Usage: codeden --server <url> --token <token> <command> [--key value ...]

Commands are the member tools; flags are their input (see "tools"):
  tools                                 What this token may use, with each tool's input
  list-projects
  get-project-status --projectId <id>
  list-sessions [--projectId <id>] [--limit <n>]
  get-session --sessionId <id>
  get-diff --sessionId <id> [--uncommitted]
  list-inbox [--projectId <id>]
  message-orchestrator --text <text>
  message-pm --projectId <id> --text <text>
  message-session --sessionId <id> --text <text> [--steer]
  start-session --projectId <id> --prompt <text> [--purpose <line>] [--provider <id>]
  stop-session --sessionId <id>
  answer-question --inboxItemId <id> --text <text>
  answer-approval --inboxItemId <id> --decision allow_once|allow_session|deny
  run-automation --automationId <id> --projectId <id>
  wait-for-session --sessionId <id> [--timeoutSec <n>]
  <command> --json '{"key": "value"}'   The whole input as JSON

The token can also be set in CODEDEN_TOKEN.`;

/** Flags whose values stay text even when they look like numbers or booleans. */
const TEXT_KEYS = new Set([
  "text",
  "prompt",
  "purpose",
  "provider",
  "model",
  "projectId",
  "sessionId",
  "inboxItemId",
  "automationId",
  "decision",
]);

export interface RemoteCommand {
  server: string;
  token: string;
  /** `tools`, or a tool name (snake_case). */
  command: string;
  input: Record<string, unknown>;
}

function coerce(key: string, value: string): unknown {
  if (TEXT_KEYS.has(key)) return value;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  if (value.startsWith("{") || value.startsWith("[")) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** Read the command line; throws a usage error in plain words. */
export function parseRemoteCommand(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
): RemoteCommand {
  let server: string | undefined;
  let token = env.CODEDEN_TOKEN;
  let command: string | undefined;
  const input: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) {
      if (command) throw new Error(`Unexpected argument: ${arg}`);
      command = arg.replace(/-/g, "_");
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    const next = args[i + 1];
    const hasValue = eq !== -1 || (next !== undefined && !next.startsWith("--"));
    const value = eq !== -1 ? arg.slice(eq + 1) : hasValue ? (next as string) : undefined;
    if (eq === -1 && hasValue) i++;
    if (key === "server") server = value;
    else if (key === "token") token = value;
    else if (key === "json") {
      const parsed = JSON.parse(value ?? "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--json takes a JSON object.");
      }
      Object.assign(input, parsed);
    } else input[key] = value === undefined ? true : coerce(key, value);
  }
  if (!server) throw new Error("Give the server with --server <url>.");
  if (!token) throw new Error("Give a token with --token <token> or CODEDEN_TOKEN.");
  if (!command) throw new Error("Give a command, e.g. tools or list-sessions.");
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new Error(`Not a URL: ${server}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Use an http(s) URL.");
  return { server: url.origin, token, command, input };
}

/** Run one command; prints the result as JSON. Returns the exit code. */
export async function runRemoteCommand(
  args: readonly string[],
  io: {
    fetch?: typeof fetch;
    out?: (text: string) => void;
    err?: (text: string) => void;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<number> {
  const out = io.out ?? ((t) => console.log(t));
  const err = io.err ?? ((t) => console.error(t));
  let cmd: RemoteCommand;
  try {
    cmd = parseRemoteCommand(args, io.env);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n\n${REMOTE_HELP}`);
    return 2;
  }
  const doFetch = io.fetch ?? fetch;
  const headers = { authorization: `Bearer ${cmd.token}`, "content-type": "application/json" };
  const url =
    cmd.command === "tools"
      ? `${cmd.server}/api/member-tools`
      : `${cmd.server}/api/member-tools/${encodeURIComponent(cmd.command)}`;
  let res: Response;
  try {
    res =
      cmd.command === "tools"
        ? await doFetch(url, { headers })
        : await doFetch(url, { method: "POST", headers, body: JSON.stringify(cmd.input) });
  } catch (error) {
    err(`Can't reach ${cmd.server}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const body = (await res.json().catch(() => null)) as {
    result?: unknown;
    tools?: unknown;
    error?: { message?: string };
  } | null;
  if (!res.ok) {
    err(body?.error?.message ?? `The server answered ${res.status}.`);
    return 1;
  }
  out(JSON.stringify(cmd.command === "tools" ? body?.tools : body?.result, null, 2));
  return 0;
}
