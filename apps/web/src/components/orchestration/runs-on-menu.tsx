import type { RunsOnChoice, Session } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Server } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";

export const runsOnKey = ["orchestration", "orchestrator", "runs-on"] as const;

/** One choice's second line: its owner's computer, its state, or why it can't take turns. */
export function choiceHint(choice: RunsOnChoice): string {
  if (!choice.ready) return choice.reason ?? "Can't take turns now";
  if (choice.id === "server") return "Next to CodeDen itself";
  return choice.owner ? "Your own computer" : "Connected";
}

/**
 * "Runs on…" in the orchestrator chat's ⋯ menu (`docs/machines-teams-and-agents.md` §D.4):
 * the server or a machine the person may use, each with whether it can take turns now. Picking
 * one moves the conversation once no turn runs; the chat then says where it went. Only on the
 * person's own, current orchestrator.
 */
export function RunsOnMenu({ session }: { session: Session }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const enabled = session.role === "orchestrator" && !session.archivedAt;
  const runsOn = useQuery({
    queryKey: runsOnKey,
    queryFn: () => client.orchestration.runsOn(),
    enabled,
    retry: false,
    staleTime: 10_000,
  });
  const set = useMutation({
    mutationFn: (id: string) => client.orchestration.setRunsOn(id),
    onSuccess: (data) => {
      queryClient.setQueryData(runsOnKey, data);
      const label = data.choices.find((c) => c.id === data.runsOn)?.label ?? data.runsOn;
      toast(`The orchestrator will run on ${label === "The server" ? "the server" : label}`, {
        description: "It moves once no turn is running; your next message starts it there.",
      });
    },
    onError: (error) =>
      toast.error("Couldn't change where the orchestrator runs", {
        description: error instanceof Error ? error.message : String(error),
      }),
  });
  if (!enabled || !runsOn.data) return null;
  const { choices } = runsOn.data;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Server />
        <span className="flex min-w-0 flex-col">
          Runs on…
          <span className="truncate text-2xs text-muted-foreground">
            {choices.find((c) => c.id === runsOn.data.runsOn)?.label ?? "A removed machine"}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        <DropdownMenuRadioGroup
          value={runsOn.data.runsOn}
          onValueChange={(id) => {
            if (id !== runsOn.data.runsOn) set.mutate(id);
          }}
        >
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice.id} value={choice.id} data-testid="runs-on-choice">
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5">
                  {choice.label}
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      choice.ready ? "bg-status-done" : "bg-muted-foreground",
                    )}
                    aria-hidden
                  />
                </span>
                <span className="text-2xs text-muted-foreground">{choiceHint(choice)}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
