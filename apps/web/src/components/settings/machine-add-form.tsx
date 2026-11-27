import type { AddMachineRequest } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClient } from "@/lib/api";
import { machinesKey } from "@/lib/machines";

/**
 * Add a machine: its SSH destination and an optional name. The server checks it over `ssh`
 * (and downloads CodeDen there the first time), which can take a while; a refusal shows the
 * server's message as it is.
 */
export function AddMachineForm() {
  const client = useClient();
  const queryClient = useQueryClient();
  const [destination, setDestination] = useState("");
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: (req: AddMachineRequest) => client.addMachine(req),
    onSuccess: (machine) => {
      setDestination("");
      setName("");
      toast.success(`${machine.label} added`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: machinesKey }),
  });
  const dest = destination.trim();
  const pending = add.isPending ? add.variables?.destination : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dest || add.isPending) return;
    const label = name.trim();
    add.mutate({ destination: dest, ...(label ? { name: label } : {}) });
  };

  return (
    <form className="space-y-3 px-4 py-3.5" onSubmit={submit} data-testid="add-machine">
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <div className="space-y-1.5">
          <Label htmlFor="machine-destination" className="text-2xs text-muted-foreground">
            SSH destination
          </Label>
          <Input
            id="machine-destination"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="user@host or an ssh config alias"
            className="font-mono text-[13px]"
            autoComplete="off"
            spellCheck={false}
            disabled={add.isPending}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="machine-name" className="text-2xs text-muted-foreground">
            Name <span className="font-normal">(optional)</span>
          </Label>
          <Input
            id="machine-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="vps-1"
            className="font-mono text-[13px]"
            autoComplete="off"
            spellCheck={false}
            disabled={add.isPending}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={!dest || add.isPending}>
          {add.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Add machine
        </Button>
        {pending && (
          <span className="text-2xs text-muted-foreground" role="status">
            Checking <span className="font-mono">{pending}</span> over SSH… the first time downloads
            CodeDen there
          </span>
        )}
      </div>
      {add.error && !add.isPending && (
        <p
          className="whitespace-pre-wrap text-2xs text-status-failed"
          role="alert"
          data-testid="add-machine-error"
        >
          {add.error.message}
        </p>
      )}
      <p className="text-2xs leading-relaxed text-muted-foreground">
        CodeDen uses your own <span className="font-mono">ssh</span>, so keys, agents and{" "}
        <span className="font-mono">~/.ssh/config</span> work as they do in a terminal. The machine
        needs Node.js 24 or newer, and signing in must not prompt.
      </p>
    </form>
  );
}
