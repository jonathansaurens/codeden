import { z } from "zod";
import { Id } from "./common";
import { MachineOwner } from "./machines";
import { RunnerRecordState } from "./runners";

/**
 * Where the orchestrator and the PMs run (`docs/machines-teams-and-agents.md` §D.4). Never chosen
 * automatically: a person picks their orchestrator's device, an Owner picks each project's PM's.
 */

/** "Runs on" the server: the home runner, next to CodeDen itself. The default. */
export const ROLE_ON_SERVER = "server";

/**
 * A role's "Runs on" setting: `server`, or a machine's id (its `runners` record id, never its
 * label, so renaming a machine keeps the choice). A person's own computer is a machine like any
 * other, that only its owner may choose (§D.5).
 */
export const RoleRunsOn = Id;
export type RoleRunsOn = z.infer<typeof RoleRunsOn>;

/** One choice for "Runs on…", as the person choosing may see it. */
export const RunsOnChoice = z.object({
  /** `server`, or the machine's id. */
  id: RoleRunsOn,
  /** "The server", or the machine's label. */
  label: z.string(),
  /** Its runner's state (the server's own runner's, for `server`). */
  state: RunnerRecordState,
  /** It can take the role's next turn now: connected and the role's provider ready there. */
  ready: z.boolean(),
  /** Why it can't, safe to show; null when it can. */
  reason: z.string().nullable(),
  /** Whose own computer it is (§D.5); null for the server and machines over SSH. */
  owner: MachineOwner.nullable().default(null),
});
export type RunsOnChoice = z.infer<typeof RunsOnChoice>;

/** `GET /api/orchestration/orchestrator/runs-on`: the caller's setting and their choices. */
export const RunsOnResponse = z.object({
  runsOn: RoleRunsOn,
  /** The server first, then the machines the caller may use. */
  choices: z.array(RunsOnChoice),
});
export type RunsOnResponse = z.infer<typeof RunsOnResponse>;

/** `PUT /api/orchestration/orchestrator/runs-on`: where the caller's orchestrator runs. */
export const SetRunsOnRequest = z.object({ runsOn: RoleRunsOn });
export type SetRunsOnRequest = z.infer<typeof SetRunsOnRequest>;

/**
 * `notice` item `code` of the note that a role moved to another device: by its setting, to the
 * server because its device couldn't take the turn, or back once it could.
 */
export const ROLE_PLACEMENT_CODE = "role_placement";

/** `data` of a `notice` item with `code: "role_placement"`. */
export const RolePlacementData = z.object({
  /**
   * - `moved`: the setting changed and the role now runs on `to`.
   * - `fallback`: the chosen device (`from`'s setting) couldn't take the turn; it runs on the server.
   * - `back`: the chosen device can take turns again; the role is back on it.
   * - `waiting`: neither the chosen device nor the server can take the turn; the message waits.
   */
  reason: z.enum(["moved", "fallback", "back", "waiting"]),
  /** Where it ran before: `server` or a machine id. */
  from: RoleRunsOn,
  /** Where it runs now: `server` or a machine id. */
  to: RoleRunsOn,
});
export type RolePlacementData = z.infer<typeof RolePlacementData>;
