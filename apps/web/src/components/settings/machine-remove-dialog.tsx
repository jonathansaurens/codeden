import type { Machine } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useClient } from "@/lib/api";
import { ApiRequestError } from "@/lib/api/http";
import { machinesKey } from "@/lib/machines";

/**
 * Confirms removing a machine. The server refuses while sessions placed there aren't archived
 * (`machine_in_use`, no way around it) and while a clone there has unpushed work
 * (`machine_unpushed`), which "Remove anyway" overrides.
 */
export function RemoveMachineDialog({
  machine,
  open,
  onOpenChange,
}: {
  machine: Machine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (force: boolean) => client.removeMachine(machine.id, { force }),
    onSuccess: () => {
      onOpenChange(false);
      toast.success(`${machine.label} removed`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: machinesKey }),
  });
  const code = remove.error instanceof ApiRequestError ? remove.error.code : null;
  const unpushed = code === "machine_unpushed";
  const inUse = code === "machine_in_use";

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) remove.reset();
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {machine.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            CodeDen stops its runner on <span className="font-mono">{machine.destination}</span> and
            forgets the machine. Files there (in{" "}
            <span className="font-mono">~/.codeden-runner</span>) are left as they are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.error && (
          <p
            className="text-sm text-status-waiting"
            role="alert"
            data-testid="remove-machine-error"
          >
            {remove.error.message}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending || inUse}
            onClick={(event) => {
              // Stay open until the server has answered; a refusal keeps the dialog.
              event.preventDefault();
              remove.mutate(unpushed);
            }}
          >
            {unpushed ? "Remove anyway" : "Remove machine"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
