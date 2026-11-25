import type { Project, RunnerRecord, StartSessionRequest } from "@codeden/contracts";
import type { AutoPlacement } from "../../execution/placement/auto";
import type { MachineService } from "../../execution/ssh/machines";
import { badRequest, ServiceError } from "../errors";
import type { RunnerPort } from "../runner-port";

/** What placement needs of the machines. */
export type MachinePlacer = Pick<MachineService, "find" | "port" | "providerReady">;

/** A new session's machine, chosen before it is created. */
export interface MachinePlacement {
  record: RunnerRecord;
  /** The machine's runner: its providers decide the session's provider. */
  port: RunnerPort;
}

const NOT_GITHUB =
  "Machines need a GitHub project: each machine clones the repository from GitHub. A local-only project runs on Home";

/**
 * Where a new session runs (`docs/machines-teams-and-agents.md` §A.5): the request's `machine`
 * when it names one, else its project's setting. Null for Home: the orchestrator, PMs, sessions
 * without a project, `home`, and projects whose sessions run on Home or in Docker. Refuses a
 * machine that doesn't exist, a project that isn't on GitHub, and a per-session choice in a
 * project whose sessions run in Docker.
 */
export function machineFor(
  machines: MachinePlacer | undefined,
  req: Pick<StartSessionRequest, "role" | "machine">,
  project: Project | null,
): MachinePlacement | "auto" | null {
  if (req.role !== "agent" || !project) return null;
  if (req.machine && project.execution?.backend === "docker") {
    throw badRequest(
      "This project's sessions run in Docker containers; choose where they run in its settings",
      "machine_unavailable",
    );
  }
  const label =
    req.machine ??
    (project.execution?.backend === "ssh" ? (project.execution?.machine ?? null) : null);
  if (!label || label === "home") return null;
  if (label === "auto") return "auto";
  const record = machines?.find(label);
  if (!record) {
    const where = req.machine ? "" : " (the project's setting); choose another in its settings";
    throw badRequest(`No machine is called ${label}${where}`, "unknown_machine");
  }
  if (project.kind !== "github") throw badRequest(NOT_GITHUB, "machine_unavailable");
  const port = machines?.port(record);
  if (!port || !record.runnerId) {
    throw new ServiceError(
      503,
      "runner_unavailable",
      `${record.label} has never connected, so nothing can run there yet`,
    );
  }
  return { record, port };
}

/**
 * Refuse a session whose provider can't run on its machine: the machine's own runner must have
 * it installed, enabled and signed in. A machine that isn't connected now is let through; the
 * start then waits for it and fails with an inbox item if it can't be reached.
 */
export async function assertProviderOnMachine(
  machines: MachinePlacer,
  placement: MachinePlacement,
  provider: string,
): Promise<void> {
  if (!placement.port.isConnected()) return;
  const label = placement.record.label ?? placement.record.id;
  const found = await machines.providerReady(placement.record, provider);
  if (!found) {
    throw badRequest(`${provider} isn't available on ${label}`, "provider_unavailable");
  }
  if (!found.ready) {
    throw badRequest(
      `${found.name} can't run on ${label}: ${found.reason ?? "not ready"}`,
      "provider_unavailable",
    );
  }
}

/** Where Automatic put a new session: the runner's journal id (null: Home) and any note. */
export interface AutoPlaced {
  runnerId: string | null;
  note: string | null;
}

/**
 * Automatic placement for a new session (§A.5): the highest-scoring of Home and the machines.
 * When none qualifies, a session a person starts is refused with why, so the form can offer
 * Home (`no_machine`); one the PM, an automation or the factory starts runs on Home, with a note
 * in its header saying so.
 */
export async function placeAutomatically(
  auto: Pick<AutoPlacement, "choose"> | undefined,
  project: Project,
  provider: string,
  startedBy: StartSessionRequest["startedBy"],
): Promise<AutoPlaced> {
  const choice = auto
    ? await auto.choose(project, provider)
    : { kind: "none" as const, reason: "No machine can take sessions automatically" };
  if (choice.kind === "home") return { runnerId: null, note: null };
  if (choice.kind === "machine") return { runnerId: choice.record.runnerId, note: null };
  if (startedBy.kind === "user") {
    throw new ServiceError(409, "no_machine", `${choice.reason}. Run it on Home instead?`);
  }
  return {
    runnerId: null,
    note: `Automatic placement found no free machine (${choice.reason}); ran on Home`,
  };
}
