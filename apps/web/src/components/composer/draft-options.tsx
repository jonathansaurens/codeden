import type { ProjectCheck, ProviderInfo } from "@codeden/contracts";
import { supportsReadOnly } from "@/components/thread/autonomy";
import { type DraftChoice, pickModel, type ResolvedDraft } from "@/lib/new-session";
import { ChecksToggle } from "./checks-toggle";
import { ModelPicker } from "./model-picker/model-picker";
import { AutonomyPicker, PlanToggle } from "./pickers";
import { RunsOnPicker } from "./runs-on-picker";
import { WorkspacePicker } from "./workspace-picker";

/**
 * The New session draft's options: the same provider and model picker (provider unlocked, since
 * the session doesn't exist yet), effort, permissions and Plan as a session's composer, kept in
 * the draft until the first send starts the session with them. What is offered follows the
 * provider's capabilities: effort with `reasoningEffort`, Read-only where it is enforced, Plan
 * with `planMode` (elsewhere Plan stays, disabled with the reason, and the draft keeps the choice
 * for a provider that can plan). "Keep going until checks pass" shows when the project has checks
 * (`checks`) and the permissions let the agent fix things. A project folder that isn't a git
 * repository shows where the session runs instead of a worktree (`WorkspacePicker`). With
 * `machines` (a GitHub project that doesn't run in Docker, once machines exist), "Runs on" picks
 * Home or a machine for this session instead of the project's setting.
 */
export function DraftOptions({
  providers,
  choice,
  resolved,
  checks,
  projectId,
  projectPath,
  machines = [],
  projectSetting = "",
  onChange,
}: {
  providers: ProviderInfo[];
  /** The project's checks a new session would freeze. */
  checks: ProjectCheck[];
  choice: DraftChoice;
  resolved: ResolvedDraft;
  /** The project, whose own model lists the picker shows and refreshes. */
  projectId: string;
  /** The project folder, named where the session runs in it. */
  projectPath: string;
  /** Machine labels the session may be placed on (`machineChoices`); empty hides "Runs on". */
  machines?: readonly string[];
  /** Where the project's setting runs sessions, for "Runs on". */
  projectSetting?: string;
  onChange: (next: DraftChoice) => void;
}) {
  const { provider } = resolved;
  const workspace = resolved.workspace === "repo_root" && <WorkspacePicker path={projectPath} />;
  const runsOn = machines.length > 0 && (
    <RunsOnPicker
      value={resolved.machine}
      machines={machines}
      projectSetting={projectSetting}
      onChange={(machine) => onChange({ ...choice, machine })}
    />
  );
  if (!provider) {
    return (
      <>
        {workspace}
        <span className="px-2 text-xs text-muted-foreground">No agent provider ready</span>
      </>
    );
  }
  return (
    <>
      {workspace}
      {runsOn}
      <ModelPicker
        providers={providers}
        projectId={projectId}
        // The resolved choice, defaults included: what the first send starts.
        value={{ provider: provider.id, model: resolved.model, effort: resolved.effort }}
        shortcut
        onChange={(next) => onChange(pickModel(choice, next))}
      />
      <AutonomyPicker
        value={resolved.autonomy}
        heading="Permissions for the new session"
        readOnlySupported={supportsReadOnly(provider)}
        onChange={(autonomy) => onChange({ ...choice, autonomy })}
      />
      <PlanToggle
        value={resolved.planMode}
        unavailable={
          provider.capabilities.planMode
            ? undefined
            : { provider: provider.displayName, wasOn: choice.planMode, canSwitch: true }
        }
        onChange={(planMode) => onChange({ ...choice, planMode })}
      />
      {checks.length > 0 && resolved.autonomy !== "read_only" && (
        <ChecksToggle
          checks={checks}
          value={{ untilPass: resolved.untilChecksPass, maxRounds: resolved.checkRounds }}
          onChange={(next) =>
            onChange({ ...choice, untilChecksPass: next.untilPass, checkRounds: next.maxRounds })
          }
        />
      )}
    </>
  );
}
