import type { RunnerRecordState } from "@codeden/contracts";
import { Server } from "lucide-react";
import { sessionMachine } from "@/lib/machines";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection";

const DOT: Partial<Record<RunnerRecordState, string>> = {
  connected: "bg-status-done",
  starting: "bg-status-waiting",
  provisioning: "bg-status-waiting",
  failed: "bg-status-failed",
};

/**
 * The machine a session runs on, in its header: the machine's label and a dot for its runner's
 * live state, with the destination (and the last error while it isn't connected) on hover.
 * Nothing for sessions on Home.
 */
export function MachineChip({
  runnerId,
  className,
}: {
  runnerId: string | null;
  className?: string;
}) {
  const machine = useConnectionStore((s) => sessionMachine(runnerId, s.runners));
  if (!machine) return null;
  const label = machine.label ?? machine.id;
  const title = [
    `Runs on ${label}${machine.sandboxRef ? ` (${machine.sandboxRef})` : ""}`,
    machine.state !== "connected" && machine.lastError ? machine.lastError : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-6 max-w-44 items-center gap-1.5 rounded-md border border-border/80 px-2 text-2xs text-muted-foreground [&_svg]:size-3",
        className,
      )}
      data-testid="machine-chip"
      data-state={machine.state}
    >
      <Server />
      <span className="truncate font-mono">{label}</span>
      <span className="sr-only">{machine.state}</span>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          DOT[machine.state] ?? "bg-muted-foreground",
        )}
        aria-hidden
      />
    </span>
  );
}
