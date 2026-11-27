import type { Project } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { SettingsSection } from "@/components/settings/settings-ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClient } from "@/lib/api";
import { machineTitle, pickableMachines, useMachines } from "@/lib/machines";
import { useCan, useMe } from "@/lib/members";

const NOT_GITHUB = "A project that isn't on GitHub keeps its PM on the server: machines clone it";

/**
 * Project page > Settings: where the project's PM runs (`Project.pmRunsOn`,
 * `docs/machines-teams-and-agents.md` §D.4). The server, a machine, or the Owner's own
 * computer; never chosen automatically. Owners only. A change moves the PM once no turn runs.
 */
export function ProjectPmRunsOn({ project }: { project: Project }) {
  const client = useClient();
  const owner = useCan("owner", project.id);
  const meId = useMe().data?.member.id;
  const machines = useMachines({ enabled: owner });
  const current = project.pmRunsOn ?? "server";
  const choices = pickableMachines(machines.data?.machines ?? [], meId);
  const set = useMutation({
    mutationFn: (pmRunsOn: string) => client.updateProject(project.id, { pmRunsOn }),
    onSuccess: () =>
      toast("The PM moves once no turn is running", {
        description: "Its next message starts it there.",
      }),
    onError: (error) =>
      toast.error(`Couldn't change where ${project.name}'s PM runs`, {
        description: error instanceof Error ? error.message : String(error),
      }),
  });
  if (!owner) return null;
  const blocked = project.kind !== "github" && current === "server";
  // A machine that was removed still shows, so the setting reads as it is.
  const known = current === "server" || choices.some((m) => m.id === current);
  return (
    <SettingsSection
      title="PM runs on"
      description="Where the project manager's conversation runs, with that device's own provider sign-ins. If it can't take a turn, the turn runs on the server and the chat says why."
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
        <Select
          value={current}
          disabled={blocked || set.isPending}
          onValueChange={(id) => {
            if (id !== current) set.mutate(id);
          }}
        >
          <SelectTrigger size="sm" className="w-56" aria-label="PM runs on">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="server">The server</SelectItem>
            {!known && <SelectItem value={current}>A removed machine</SelectItem>}
            {choices.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {machineTitle(m)}
                {m.state !== "connected" ? " (offline)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {blocked && (
          <p className="text-2xs text-muted-foreground" data-testid="pm-runs-on-unavailable">
            {NOT_GITHUB}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
