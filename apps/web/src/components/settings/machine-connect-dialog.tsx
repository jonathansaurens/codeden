import type { ConnectCodeState } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, Laptop, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useClient } from "@/lib/api";
import { copyWithFeedback } from "@/lib/copy";
import { machinesKey } from "@/lib/machines";
import { useAgentServerUrl } from "./agent-snippets";

const STATE_TEXT: Record<ConnectCodeState, string> = {
  waiting: "Waiting for your computer…",
  paired: "Paired. Linking its runner…",
  connected: "Connected. It's in your machines now.",
  expired: "This code has expired.",
};

/**
 * Settings › Machines › Connect this computer (`docs/machines-teams-and-agents.md` §D.5): a
 * single-use pairing code and the command to run with it on the computer to connect, then its
 * state, polled until the computer's runner links in. The code is made when the dialog opens
 * and shown only here.
 */
function ConnectDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const serverUrl = useAgentServerUrl();
  const create = useMutation({ mutationFn: () => client.createConnectCode(serverUrl) });
  const { mutate } = create;
  // One code per opening (an effect may run twice in development); "Get a new code" makes another.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    mutate();
  }, [mutate]);
  const code = create.data;
  const status = useQuery({
    queryKey: ["machines", "connect-code", code?.id],
    queryFn: () => client.connectCodeStatus(code?.id as string),
    enabled: !!code,
    refetchInterval: (q) =>
      q.state.data?.state === "connected" || q.state.data?.state === "expired" ? false : 1500,
  });
  const state = status.data?.state ?? "waiting";
  useEffect(() => {
    if (state === "connected") void queryClient.invalidateQueries({ queryKey: machinesKey });
  }, [state, queryClient]);

  return (
    <DialogContent className="sm:max-w-xl" data-testid="connect-computer-dialog">
      <DialogHeader>
        <DialogTitle>Connect this computer</DialogTitle>
        <DialogDescription>
          Run this in a terminal on the computer you want to connect (it needs Node.js 24 or newer).
          It links out to CodeDen, so nothing needs to reach it, and its agents use that computer's
          own provider sign-ins. Only you can run sessions on it.
        </DialogDescription>
      </DialogHeader>
      {create.error ? (
        <p className="text-sm text-status-failed" role="alert">
          {create.error.message}
        </p>
      ) : !code ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Making a pairing code…
        </p>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="mb-1 flex items-center justify-between text-2xs font-medium">
              Command
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void copyWithFeedback(code.command, "Command copied")}
              >
                <Copy /> Copy
              </Button>
            </div>
            <pre
              className="overflow-auto rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap break-all"
              data-testid="connect-command"
            >
              {code.command}
            </pre>
            <p className="mt-1 text-2xs text-muted-foreground">
              The code works once, for 10 minutes. Add <span className="font-mono">--detach</span>{" "}
              to keep the link running in the background; later,{" "}
              <span className="font-mono">codeden connect</span> links it again and{" "}
              <span className="font-mono">codeden connect --stop</span> ends it.
            </p>
          </div>
          <p
            className="flex items-center gap-2 text-sm"
            data-testid="connect-state"
            data-state={state}
          >
            {state === "connected" ? (
              <CheckCircle2 className="size-4 text-status-done" />
            ) : state === "expired" ? null : (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            )}
            {STATE_TEXT[state]}
          </p>
          <div className="flex justify-end gap-2">
            {state === "expired" && (
              <Button variant="outline" size="sm" onClick={() => mutate()}>
                Get a new code
              </Button>
            )}
            <Button
              size="sm"
              variant={state === "connected" ? "default" : "ghost"}
              onClick={() => onOpenChange(false)}
            >
              {state === "connected" ? "Done" : "Close"}
            </Button>
          </div>
        </div>
      )}
    </DialogContent>
  );
}

/** The "Connect this computer" button and its dialog. */
export function ConnectComputerButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Laptop /> Connect this computer
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <ConnectDialog onOpenChange={setOpen} />}
      </Dialog>
    </>
  );
}
