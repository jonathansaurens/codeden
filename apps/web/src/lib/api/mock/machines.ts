import {
  AddMachineRequest,
  DEFAULT_MACHINE_WEIGHT,
  type Machine,
  type MachineWeight,
  type RunnerRecord,
} from "@codeden/contracts";
import { ApiRequestError } from "../http";
import type { MachinesMethods } from "../machines-api";
import type { MockWorld } from "./world";

const later = <T>(value: T, ms: number): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

const COMMAND = "npx -y codeden@0.1.0";

/** The sample machine, matching the `machine-vps-1` runner in the world fixture. */
const vps1: Machine = {
  id: "machine-vps-1",
  label: "vps-1",
  destination: "deploy@vps-1.example.net",
  weight: 50,
  state: "connected",
  version: "0.1.0",
  platform: "linux",
  arch: "x64",
  lastError: null,
  lastSeenAt: "2026-11-25T08:00:00.000Z",
  sessions: 0,
  resources: null,
  providers: [
    { id: "claude-code", name: "Claude Code", ready: true, reason: null },
    { id: "codex", name: "Codex", ready: false, reason: "Not signed in: run `codex login` there" },
  ],
};

/** A destination's host name, as the server labels a machine added without a name. */
function hostOf(destination: string): string {
  const host = destination
    .replace(/^ssh:\/\//, "")
    .replace(/^[^@]*@/, "")
    .replace(/:\d+$/, "");
  return host.split(".")[0]?.replace(/[^A-Za-z0-9._-]/g, "-") || "machine";
}

function runnerOf(m: Machine): RunnerRecord {
  return {
    id: m.id,
    backend: "ssh",
    home: false,
    runnerId: `runner-${m.label}`,
    sandboxRef: m.destination,
    label: m.label,
    weight: m.weight,
    projectId: null,
    sessionId: null,
    state: m.state,
    version: m.version,
    imageVersion: null,
    createdAt: new Date().toISOString(),
    lastSeenAt: m.lastSeenAt,
    lastError: m.lastError,
  };
}

/**
 * Machines in the mock: one connected sample (`vps-1`). Adding checks nothing real: a destination
 * containing `fail` is refused as the server refuses an SSH sign-in, anything else connects after
 * a pause. Removing `vps-1` the first time reports unpushed work, so the forced path can be tried.
 */
export function mockMachinesApi(world: MockWorld): MachinesMethods {
  let machines: Machine[] = [structuredClone(vps1)];
  let unpushedWarned = false;
  const find = (id: string) => {
    const m = machines.find((x) => x.id === id);
    if (!m) throw new ApiRequestError(404, "not_found", `No machine ${id}`);
    return m;
  };
  const syncRunners = () =>
    world.setRunners([
      ...world.snapshot.runners.filter((r) => r.backend !== "ssh"),
      ...machines.map(runnerOf),
    ]);

  return {
    machines: () =>
      later(
        { machines, command: COMMAND, homeWeight: DEFAULT_MACHINE_WEIGHT, homeResources: null },
        120,
      ),

    async addMachine(input) {
      const req = AddMachineRequest.parse(input);
      const label = req.name ?? hostOf(req.destination);
      await later(null, 1500);
      if (machines.some((m) => m.label.toLowerCase() === label.toLowerCase())) {
        throw new ApiRequestError(409, "name_taken", `A machine is already called ${label}`);
      }
      if (machines.some((m) => m.destination === req.destination)) {
        throw new ApiRequestError(409, "already_added", `${req.destination} is already added`);
      }
      if (req.destination.includes("fail")) {
        throw new ApiRequestError(
          400,
          "ssh_auth",
          `ssh couldn't sign in to ${req.destination} without a prompt: add your key with ssh-copy-id ${req.destination}`,
        );
      }
      const machine: Machine = {
        ...structuredClone(vps1),
        id: `machine-${label}`,
        label,
        destination: req.destination,
        weight: DEFAULT_MACHINE_WEIGHT,
        lastSeenAt: new Date().toISOString(),
        sessions: 0,
      };
      machines = [...machines, machine];
      syncRunners();
      return structuredClone(machine);
    },

    async setMachineWeight(id, weight: MachineWeight) {
      const updated = { ...find(id), weight };
      machines = machines.map((m) => (m.id === id ? updated : m));
      syncRunners();
      return later(updated, 80);
    },

    async removeMachine(id, opts) {
      const m = find(id);
      await later(null, 200);
      if (m.sessions > 0) {
        throw new ApiRequestError(
          409,
          "machine_in_use",
          `${m.label} still has ${m.sessions} session${m.sessions === 1 ? "" : "s"}; archive ${m.sessions === 1 ? "it" : "them"} first`,
        );
      }
      if (m.label === "vps-1" && !opts?.force && !unpushedWarned) {
        unpushedWarned = true;
        throw new ApiRequestError(
          409,
          "machine_unpushed",
          "A clone on vps-1 has commits that aren't pushed (codeden/fix-login). Remove anyway to delete them.",
        );
      }
      machines = machines.filter((x) => x.id !== id);
      syncRunners();
    },
  };
}

/**
 * Automatic placement in the mock: a person's start placed `auto` (by the request, or by a
 * project set to Automatic) whose text mentions "busy" finds every machine busy and is refused
 * as the server refuses it (409 `no_machine`). Anything else starts.
 */
export function mockAutoPlacement(
  input: { machine?: string; input?: { text?: string } },
  project: { execution?: { backend: string; machine?: string | null } } | undefined,
): void {
  const projectAuto = project?.execution?.backend === "ssh" && project.execution.machine === "auto";
  const auto = input.machine === "auto" || (input.machine === undefined && projectAuto);
  if (auto && /\bbusy\b/i.test(input.input?.text ?? "")) {
    throw new ApiRequestError(409, "no_machine", "All machines are busy. Run it on Home instead?");
  }
}
