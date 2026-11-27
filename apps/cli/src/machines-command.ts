import {
  AddMachineResponse,
  MACHINE_PREFERENCES,
  type Machine,
  MachinesResponse,
} from "@codeden/contracts";
import { ensureInstallToken, homePaths } from "@codeden/server";
import { findRunningServer } from "./running";

const USAGE = `Usage:
  codeden machines list
  codeden machines add <ssh-destination> [--name <label>]
  codeden machines remove <name> [--force]`;

type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** The running server's API with this home's install token; null when no server runs. */
async function serverApi(home: string): Promise<Api | null> {
  const paths = homePaths(home);
  const server = await findRunningServer(paths.serverLock);
  if (!server) return null;
  const token = ensureInstallToken(paths.token);
  return async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!res.ok) throw new Error(json?.error?.message ?? `The server answered ${res.status}`);
    return json;
  };
}

const preference = (weight: number) =>
  MACHINE_PREFERENCES.find((p) => p.weight === weight)?.label ?? String(weight);

function line(m: Machine): string {
  const where = [m.platform, m.arch].filter(Boolean).join("/");
  const ready = m.providers.filter((p) => p.ready).map((p) => p.id);
  return [
    m.label.padEnd(16),
    m.destination.padEnd(28),
    m.state.padEnd(13),
    (m.version ?? "").padEnd(8),
    where.padEnd(13),
    preference(m.weight).padEnd(12),
    `${m.sessions} session${m.sessions === 1 ? "" : "s"}`,
    ready.length ? `  providers: ${ready.join(", ")}` : "",
  ].join(" ");
}

/**
 * `codeden machines list|add|remove` (`docs/machines-teams-and-agents.md` §A.2): manage the
 * machines of the CodeDen running in this home, through its API. Adding checks the machine
 * over `ssh` first and says what to fix when a check fails.
 */
export async function machinesCommand(
  home: string,
  args: string[],
  opts: { name?: string; force: boolean },
): Promise<number> {
  const [action, target] = args;
  if (!action || !["list", "add", "remove"].includes(action)) {
    console.error(USAGE);
    return 2;
  }
  if (action !== "list" && !target) {
    console.error(USAGE);
    return 2;
  }
  const api = await serverApi(home);
  if (!api) {
    console.error("CodeDen is not running. Start it with `codeden`, then try again.");
    return 1;
  }
  try {
    if (action === "list") {
      const { machines, command } = MachinesResponse.parse(await api("GET", "/machines"));
      if (machines.length === 0)
        console.log("No machines yet. Add one: codeden machines add <ssh-destination>");
      for (const m of machines) console.log(line(m));
      console.log(`\nMachines run CodeDen with: ${command}`);
      return 0;
    }
    if (action === "add") {
      console.log(`Checking ${target} over ssh (the first time downloads CodeDen there)…`);
      const body = { destination: target, ...(opts.name ? { name: opts.name } : {}) };
      const { machine } = AddMachineResponse.parse(await api("POST", "/machines", body));
      console.log(`Added ${machine.label}.`);
      console.log(line(machine));
      return 0;
    }
    const query = opts.force ? "?force=true" : "";
    await api("DELETE", `/machines/${encodeURIComponent(target as string)}${query}`);
    console.log(`Removed ${target}.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
