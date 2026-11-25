import type { AgentRole, CreateAgentResponse, ProjectRoles } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/api";
import { copyWithFeedback } from "@/lib/copy";
import { membersKey } from "@/lib/members";
import { ProjectRolesEditor, RoleSelect } from "./member-dialogs";

const AGENT_ROLES = ["none", "viewer", "operator"] as const;

/** A token shown once, with a copy button. */
export function TokenOnce({ token }: { token: string }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input readOnly value={token} className="font-mono text-xs" data-testid="agent-token" />
        <Button variant="outline" onClick={() => void copyWithFeedback(token, "Token copied")}>
          <Copy /> Copy
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        This is the only time the token is shown. Keep it like a password; revoke it here if it
        leaks.
      </p>
    </div>
  );
}

/**
 * Settings › Members › Add agent (§C.1): a connected agent with a name, Viewer or Operator (never
 * Owner), optional per-project roles, the "May answer approvals" switch (off by default), and a
 * token shown once.
 */
export function AddAgentDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState<AgentRole>("operator");
  const [projectRoles, setProjectRoles] = useState<ProjectRoles>({});
  const [mayAnswerApprovals, setMayAnswerApprovals] = useState(false);
  const [created, setCreated] = useState<CreateAgentResponse | null>(null);
  const create = useMutation({
    mutationFn: () =>
      client.members.createAgent({
        name: name.trim(),
        role,
        projectRoles: projectRoles as Record<string, AgentRole>,
        mayAnswerApprovals,
      }),
    onSuccess: (res) => {
      setCreated(res);
      void queryClient.invalidateQueries({ queryKey: membersKey });
    },
    onError: (e) => toast.error("Agent not added", { description: e.message }),
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xl" data-testid="add-agent-dialog">
        <DialogHeader>
          <DialogTitle>
            {created ? `${created.member.name} is connected` : "Add an agent"}
          </DialogTitle>
          <DialogDescription>
            A connected agent uses CodeDen over MCP, the HTTP API or the codeden CLI, with its own
            token and role. What it sends reaches your agents as a member's message, never as
            CodeDen's own instructions.
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <TokenOnce token={created.token} />
        ) : (
          <div className="space-y-4">
            <Input
              placeholder="Name, e.g. Release bot"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              aria-label="Agent name"
            />
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span className="font-medium">Role everywhere</span>
              <RoleSelect
                label="Agent role"
                value={role}
                roles={AGENT_ROLES}
                onChange={(r) => setRole(r as AgentRole)}
              />
            </div>
            <div className="space-y-1.5">
              <div className="text-[13px] font-medium">Per project (optional)</div>
              <ProjectRolesEditor
                value={projectRoles}
                onChange={setProjectRoles}
                roles={AGENT_ROLES}
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span>
                <span className="font-medium">May answer approvals</span>
                <span className="block text-2xs text-muted-foreground">
                  Off: it can answer agents' questions, but approvals wait for a person.
                </span>
              </span>
              <Switch
                checked={mayAnswerApprovals}
                onCheckedChange={setMayAnswerApprovals}
                aria-label="May answer approvals"
              />
            </div>
          </div>
        )}
        <DialogFooter>
          {created ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <Button onClick={() => create.mutate()} disabled={create.isPending || !name.trim()}>
              {create.isPending && <Loader2 className="animate-spin" />} Add agent
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
