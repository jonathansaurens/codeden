import type { Machine } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { machinesKey } from "@/lib/machines";

/**
 * Shown on a machine whose CodeDen data was wiped (`Machine.reinstalled`): CodeDen won't treat
 * it as the same machine, so it offers to reconnect it as a new one under the same name. The
 * server refuses while sessions placed there aren't archived, and says so.
 */
export function ReinstalledNotice({ machine }: { machine: Machine }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const reconnect = useMutation({
    mutationFn: () => client.reconnectMachine(machine.id),
    onSuccess: () => toast.success(`${machine.label} reconnected`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: machinesKey }),
  });
  return (
    <div className="space-y-1.5 pt-0.5" data-testid="machine-reinstalled">
      <p className="text-2xs text-status-failed">
        {machine.label} was wiped or set up again, so CodeDen no longer trusts it as the same
        machine. Reconnect it as a new one; projects that use it keep working.
      </p>
      {reconnect.error && <p className="text-2xs text-status-failed">{reconnect.error.message}</p>}
      <Button
        variant="outline"
        size="sm"
        disabled={reconnect.isPending}
        onClick={() => reconnect.mutate()}
      >
        <RotateCw className={reconnect.isPending ? "animate-spin" : undefined} />
        {reconnect.isPending ? "Reconnecting…" : "Reconnect"}
      </Button>
    </div>
  );
}
