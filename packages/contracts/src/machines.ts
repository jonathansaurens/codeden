import { z } from "zod";
import { Id, Timestamp } from "./common";
import { RunnerRecordState } from "./runners";

/**
 * Machines (`docs/machines-teams-and-agents.md` Part A): other computers CodeDen reaches over the
 * user's own `ssh`, each running a long-lived runner of its own in `~/.codeden-runner`. A machine
 * is a `runners` record with backend `ssh`, its SSH destination in `sandboxRef`, a `label` and a
 * `weight` (its preference for automatic placement).
 */

/** The machine runner's home, as the remote shell expands it (journal, lock file, clones). */
export const MACHINE_RUNNER_HOME = "~/.codeden-runner";

/** The oldest Node.js a machine may run CodeDen's runner with. */
export const MACHINE_MIN_NODE_MAJOR = 24;

/**
 * Where to reach a machine: anything `ssh` accepts as a destination (`user@host`, a `Host` alias
 * from `~/.ssh/config`, a Tailscale name, `ssh://user@host:2222`). No whitespace or control
 * characters, and never a leading `-`, so it can't be read as an `ssh` option.
 */
export const SshDestination = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\s-][^\s]*$/, "An SSH destination has no spaces and doesn't start with -")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
  .refine((s) => !/[\u0000-\u001f\u007f'"`$\\;|&<>()]/.test(s), {
    message: "An SSH destination has no quotes, shell characters or control characters",
  });
export type SshDestination = z.infer<typeof SshDestination>;

/** Labels a machine can't take: they name the other placements. */
const RESERVED_LABELS = new Set(["home", "auto"]);

/**
 * A machine's short name, unique among machines: shown in the UI and used to place sessions by
 * name (`machine: "vps-1"`). Letters, digits, `.`, `_` and `-`; never `home` or `auto`.
 */
export const MachineLabel = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/, "Use up to 40 letters, digits, '.', '_' or '-'")
  .refine((s) => !RESERVED_LABELS.has(s.toLowerCase()), {
    message: "'home' and 'auto' are reserved",
  });
export type MachineLabel = z.infer<typeof MachineLabel>;

/**
 * Where one session runs, overriding its project's setting (`StartSessionRequest.machine`):
 * `home` (this computer's runner), `auto` (automatic placement, §A.5) or a machine's label.
 */
export const SessionPlacement = z.union([z.literal("home"), z.literal("auto"), MachineLabel]);
export type SessionPlacement = z.infer<typeof SessionPlacement>;

/**
 * A machine's preference for automatic placement (its record's `weight`): Prefer 100, Normal 50
 * (the default), Less often 25, Manual only 0 (never chosen automatically, only by name).
 */
export const MachineWeight = z.union([z.literal(100), z.literal(50), z.literal(25), z.literal(0)]);
export type MachineWeight = z.infer<typeof MachineWeight>;

/** A machine's weight when none was set. */
export const DEFAULT_MACHINE_WEIGHT: MachineWeight = 50;

/** The preferences in the order the UI offers them, with their labels. */
export const MACHINE_PREFERENCES: ReadonlyArray<{ weight: MachineWeight; label: string }> = [
  { weight: 100, label: "Prefer" },
  { weight: 50, label: "Normal" },
  { weight: 25, label: "Less often" },
  { weight: 0, label: "Manual only" },
];

/**
 * A machine's free capacity, for automatic placement (`host.resources`, §A.5). On Linux a
 * container's cgroup v2 limits count when set, so `cpuCount` may be fractional.
 */
export const HostResources = z.object({
  cpuCount: z.number().positive(),
  /** Share of CPU time busy over about a second, 0 to 1. */
  cpuBusy: z.number().min(0).max(1),
  totalMemoryBytes: z.number().nonnegative(),
  /** Free memory, counting what the OS can reclaim (macOS: `vm_stat`; Linux cgroups: cache). */
  availableMemoryBytes: z.number().nonnegative(),
  sampledAt: Timestamp,
});
export type HostResources = z.infer<typeof HostResources>;

/**
 * Why adding a machine failed (`AddMachineResponse` errors, `code` of the API error):
 * - `name_taken`: another machine has this label;
 * - `already_added`: a machine with this destination exists;
 * - `ssh_unreachable`: the host can't be resolved or reached;
 * - `ssh_auth`: `ssh` couldn't sign in without prompting (no key, key not accepted);
 * - `ssh_host_key`: the host key is unknown or changed;
 * - `ssh_failed`: any other `ssh` failure;
 * - `node_missing`: no `node` on the machine's PATH for non-interactive shells;
 * - `node_too_old`: Node.js older than `MACHINE_MIN_NODE_MAJOR`;
 * - `codeden_failed`: the pinned `codeden` didn't run there (npm, network, version);
 * - `runner_failed`: the machine's runner didn't start or answer.
 */
export const MachineCheckCode = z.enum([
  "name_taken",
  "already_added",
  "ssh_unreachable",
  "ssh_auth",
  "ssh_host_key",
  "ssh_failed",
  "node_missing",
  "node_too_old",
  "codeden_failed",
  "runner_failed",
]);
export type MachineCheckCode = z.infer<typeof MachineCheckCode>;

/** `POST /api/machines`: add a machine after checking it (`codeden machines add`). */
export const AddMachineRequest = z.object({
  destination: SshDestination,
  /** Its label; defaults to the destination's host name. */
  name: MachineLabel.optional(),
});
export type AddMachineRequest = z.infer<typeof AddMachineRequest>;

/** A provider as a machine's own runner reports it. */
export const MachineProvider = z.object({
  id: z.string(),
  name: z.string(),
  /** Installed, supported and signed in there: sessions on it may be placed on the machine. */
  ready: z.boolean(),
  /** Why not, when it isn't ready; null when it is (or before the first check). */
  reason: z.string().nullable(),
});
export type MachineProvider = z.infer<typeof MachineProvider>;

/** One machine, with what its runner last reported (`GET /api/machines`). */
export const Machine = z.object({
  /** Its runner record's id. */
  id: Id,
  label: MachineLabel,
  destination: z.string(),
  weight: MachineWeight,
  state: RunnerRecordState,
  /** The CodeDen version its runner reported. */
  version: z.string().nullable(),
  platform: z.string().nullable(),
  arch: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSeenAt: Timestamp.nullable(),
  /** Sessions placed on it that aren't archived. */
  sessions: z.int().nonnegative(),
  providers: z.array(MachineProvider),
  /** Its last capacity answer (§A.5); null before one, or while it can't be reached. */
  resources: HostResources.nullable().default(null),
});
export type Machine = z.infer<typeof Machine>;

/** `GET /api/machines`: every machine, and the command they run CodeDen with. */
export const MachinesResponse = z.object({
  machines: z.array(Machine),
  /** Home's own preference for automatic placement; Home is a candidate like any machine. */
  homeWeight: MachineWeight.default(DEFAULT_MACHINE_WEIGHT),
  /** Home's last capacity answer. */
  homeResources: HostResources.nullable().default(null),
  /**
   * The command prefix every machine runs CodeDen with: `npx -y codeden@<server version>`, or
   * the owner's development override (`CODEDEN_MACHINE_COMMAND`).
   */
  command: z.string(),
});
export type MachinesResponse = z.infer<typeof MachinesResponse>;

/** `POST /api/machines` response: the machine, connected. */
export const AddMachineResponse = z.object({ machine: Machine });
export type AddMachineResponse = z.infer<typeof AddMachineResponse>;
