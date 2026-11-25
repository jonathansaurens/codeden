import { MACHINE_PREFERENCES, type MachineWeight } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClient } from "@/lib/api";
import { machinesKey } from "@/lib/machines";

/** The help shown once above the preference pickers. */
export const PREFERENCE_HELP =
  "Automatic placement picks the candidate with the highest preference × cores × free CPU × free memory. Manual only: never chosen automatically.";

/**
 * A machine's (or, without `machineId`, Home's) preference for automatic placement: Prefer,
 * Normal, Less often or Manual only (`MACHINE_PREFERENCES`).
 */
export function PreferencePicker({
  machineId,
  name,
  weight,
}: {
  /** The machine's id; absent for Home. */
  machineId?: string;
  /** Who it is for, in its label and in a failure. */
  name: string;
  weight: MachineWeight;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: async (next: MachineWeight) => {
      if (machineId) await client.setMachineWeight(machineId, next);
      else await client.setHomeWeight(next);
    },
    onError: (e) => toast.error(`Couldn't change ${name}'s preference`, { description: e.message }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: machinesKey }),
  });
  // Show the choice at once; the query catches up after the save.
  const value = save.isPending && save.variables !== undefined ? save.variables : weight;
  return (
    <Select
      value={String(value)}
      onValueChange={(v) => save.mutate(Number(v) as MachineWeight)}
      disabled={save.isPending}
    >
      <SelectTrigger size="sm" className="w-32" aria-label={`${name}'s preference`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MACHINE_PREFERENCES.map((p) => (
          <SelectItem key={p.weight} value={String(p.weight)}>
            {p.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
