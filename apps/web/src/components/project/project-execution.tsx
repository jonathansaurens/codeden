import type { Project, ProjectExecutionBackend } from "@codeden/contracts";
import { useQuery } from "@tanstack/react-query";
import { ExperimentalBadge } from "@/components/factory/autonomy-dialog";
import { Segmented, SettingsSection } from "@/components/settings/settings-ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClient } from "@/lib/api";
import { useMachines } from "@/lib/machines";
import { useProjectActions } from "@/lib/project-actions";

const NOT_GITHUB = "Machines need a GitHub project";
const NO_MACHINES = "Add a machine in Settings › Machines";

/**
 * Project page > Settings: where the project's new agent sessions run (`Project.execution`,
 * `docs/remote-runners.md` §5). This machine (worktrees), experimentally a Docker container per
 * session, or one of the machines reached over SSH. Docker can't be picked while it isn't
 * available, and neither Docker nor a machine for a project that isn't on GitHub; machines need at
 * least one added in Settings. The reason is shown.
 */
export function ProjectExecution({ project }: { project: Project }) {
  const client = useClient();
  const { setExecutionBackend } = useProjectActions();
  const backends = useQuery({
    queryKey: ["execution", "backends", project.id, project.kind],
    queryFn: () => client.executionBackends({ projectId: project.id }),
    retry: false,
    staleTime: 30_000,
  });
  const machines = useMachines();
  const labels = machines.data?.machines.map((m) => m.label) ?? [];
  const docker = backends.data?.backends.find((b) => b.backend === "docker");
  // A project from an older server has no setting: it runs locally.
  const current = project.execution?.backend ?? "local";
  const currentMachine = project.execution?.machine ?? null;
  const blocked = !docker?.available;
  const reason = docker
    ? [docker.reason, docker.fix].filter(Boolean).join(". ")
    : backends.isPending
      ? "Checking Docker…"
      : "Docker couldn't be checked";
  const machineBlocked =
    project.kind !== "github" ? NOT_GITHUB : labels.length === 0 ? NO_MACHINES : null;

  const pick = (backend: ProjectExecutionBackend) => {
    if (backend === current) return;
    if (backend !== "ssh") return void setExecutionBackend(project, backend);
    const label = labels[0];
    if (label) void setExecutionBackend(project, "ssh", label);
  };

  return (
    <SettingsSection
      title="Where sessions run"
      description="Where new agent sessions in this project run. Sessions that already started stay where they are."
    >
      <div className="space-y-3 px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13.5px] font-medium">
            Agent sessions
            {current === "docker" && <ExperimentalBadge />}
          </div>
          <div className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
            {current === "docker" ? (
              <>
                Each new agent session gets a Docker container of its own, which clones the
                repository from GitHub. Archiving the session removes the container. For now only
                providers that need no sign-in run there.
              </>
            ) : current === "ssh" ? (
              <>
                Each new agent session runs on{" "}
                <span className="font-mono">{currentMachine ?? "a machine"}</span>, in a clone of
                the repository from GitHub, with that machine's own provider sign-ins.
              </>
            ) : (
              <>Each new agent session works in a worktree on this machine.</>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<ProjectExecutionBackend>
            value={current}
            onChange={pick}
            options={[
              { value: "local", label: "This machine" },
              {
                value: "docker",
                label: "Docker (experimental)",
                disabled: blocked && current !== "docker",
                title: blocked ? reason : undefined,
              },
              {
                value: "ssh",
                label: "A machine",
                disabled: Boolean(machineBlocked) && current !== "ssh",
                title: machineBlocked ?? undefined,
              },
            ]}
          />
          {current === "ssh" && (
            <Select
              value={currentMachine ?? undefined}
              onValueChange={(label) => {
                if (label !== currentMachine) void setExecutionBackend(project, "ssh", label);
              }}
            >
              <SelectTrigger size="sm" className="w-44" aria-label="Machine">
                <SelectValue placeholder="Choose a machine" />
              </SelectTrigger>
              <SelectContent>
                {/* A machine that was removed still shows, so the setting reads as it is. */}
                {[...new Set([...(currentMachine ? [currentMachine] : []), ...labels])].map(
                  (label) => (
                    <SelectItem key={label} value={label}>
                      {label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          )}
        </div>
        {blocked && (
          <p className="text-2xs text-muted-foreground" data-testid="docker-unavailable">
            {reason}
          </p>
        )}
        {machineBlocked && !machines.isPending && (
          <p className="text-2xs text-muted-foreground" data-testid="machines-unavailable">
            {machineBlocked}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
