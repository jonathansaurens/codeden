import type { Machine, RunnerRecordState } from "@codeden/contracts";
import { Server, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ago } from "@/lib/format";
import { useMachines, withLiveState } from "@/lib/machines";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection";
import { AddMachineForm } from "./machine-add-form";
import { RemoveMachineDialog } from "./machine-remove-dialog";
import { SettingsSection } from "./settings-ui";

/** How a machine's runner state reads, and its colour. */
const STATE: Partial<Record<RunnerRecordState, { label: string; tone: string }>> = {
  connected: { label: "Connected", tone: "text-status-done border-status-done/40" },
  disconnected: { label: "Disconnected", tone: "text-muted-foreground border-border" },
  provisioning: { label: "Starting", tone: "text-status-waiting border-status-waiting/40" },
  starting: { label: "Starting", tone: "text-status-waiting border-status-waiting/40" },
  failed: { label: "Failed", tone: "text-status-failed border-status-failed/40" },
};
const OTHER_STATE = { label: "Disconnected", tone: "text-muted-foreground border-border" };

function StateBadge({ state }: { state: RunnerRecordState }) {
  const s = STATE[state] ?? OTHER_STATE;
  return (
    <span
      className={cn("rounded border px-1.5 py-px text-3xs", s.tone)}
      data-testid="machine-state"
    >
      {s.label}
    </span>
  );
}

/** What the machine's runner reported: version, platform, sessions, last seen. */
function machineFacts(m: Machine): string {
  return [
    m.version ? `CodeDen ${m.version}` : null,
    m.platform ? [m.platform, m.arch].filter(Boolean).join("/") : null,
    `${m.sessions} session${m.sessions === 1 ? "" : "s"}`,
    m.state !== "connected" && m.lastSeenAt ? `seen ${ago(m.lastSeenAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function MachineRow({ machine }: { machine: Machine }) {
  const [removing, setRemoving] = useState(false);
  const ready = machine.providers.filter((p) => p.ready);
  const notReady = machine.providers.filter((p) => !p.ready);
  return (
    <div className="flex items-start gap-4 px-4 py-3.5" data-testid="machine-row">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-medium">{machine.label}</span>
          <StateBadge state={machine.state} />
        </div>
        <div className="truncate font-mono text-[12.5px] text-muted-foreground">
          {machine.destination}
        </div>
        <div className="text-2xs text-muted-foreground">{machineFacts(machine)}</div>
        {machine.providers.length > 0 && (
          <div className="text-2xs leading-relaxed" data-testid="machine-providers">
            {ready.length > 0 ? (
              <span>Ready: {ready.map((p) => p.name).join(", ")}</span>
            ) : (
              <span className="text-muted-foreground">No provider ready there</span>
            )}
            {notReady.map((p) => (
              <div key={p.id} className="text-muted-foreground">
                {p.name}: {p.reason ?? "not ready"}
              </div>
            ))}
          </div>
        )}
        {machine.lastError && (
          <p className="whitespace-pre-wrap text-2xs text-status-failed">{machine.lastError}</p>
        )}
        {/* Live capacity and the placement preference join this row later. */}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={`Remove ${machine.label}`}
          onClick={() => setRemoving(true)}
        >
          <Trash2 />
        </Button>
      </div>
      <RemoveMachineDialog machine={machine} open={removing} onOpenChange={setRemoving} />
    </div>
  );
}

/**
 * Settings > Machines: other computers CodeDen runs agent sessions on over SSH, each with a
 * runner of its own. Their state is live from the realtime runner list; the rest is what
 * `GET /api/machines` last reported.
 */
export function MachinesSettings() {
  const query = useMachines();
  const runners = useConnectionStore((s) => s.runners);
  const machines = useMemo(
    () => withLiveState(query.data?.machines ?? [], runners),
    [query.data, runners],
  );
  return (
    <>
      <SettingsSection
        title="Machines"
        description="Other computers that run agent sessions, reached with your own ssh. Each clones a GitHub project's repository and uses its own provider sign-ins."
      >
        {query.error ? (
          <p className="px-4 py-3.5 text-2xs text-status-failed">{query.error.message}</p>
        ) : query.isPending ? (
          <p className="px-4 py-3.5 text-2xs text-muted-foreground">Loading machines…</p>
        ) : machines.length === 0 ? (
          <div className="flex items-center gap-3 px-4 py-3.5 text-2xs text-muted-foreground">
            <Server className="size-4 shrink-0" />
            No machines yet. Add one below; then pick it for a project in its Settings, or for one
            session when you start it.
          </div>
        ) : (
          machines.map((m) => <MachineRow key={m.id} machine={m} />)
        )}
        {query.data && (
          <p className="px-4 py-3 text-2xs text-muted-foreground" data-testid="machine-command">
            Machines run CodeDen with:{" "}
            <code className="rounded bg-muted px-1 py-px font-mono text-foreground">
              {query.data.command}
            </code>
          </p>
        )}
      </SettingsSection>
      <SettingsSection title="Add a machine">
        <AddMachineForm />
      </SettingsSection>
    </>
  );
}
