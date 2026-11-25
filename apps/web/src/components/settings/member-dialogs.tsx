import type { CreateInviteResponse, MemberRole, ProjectRoles } from "@codeden/contracts";
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
import { serverOrigin, useClient } from "@/lib/api";
import { copyWithFeedback } from "@/lib/copy";
import { membersKey, ROLE_LABEL } from "@/lib/members";
import { useSnapshotData } from "@/lib/queries";

/** A role picker; `roles` limits the choice (agents are never owners). */
export function RoleSelect({
  value,
  onChange,
  roles = ["none", "viewer", "operator", "owner"],
  label,
  inherit,
}: {
  value: MemberRole | "inherit";
  onChange: (role: MemberRole | "inherit") => void;
  roles?: readonly MemberRole[];
  label: string;
  /** Offer "Same as everywhere" (a per-project override that isn't set). */
  inherit?: boolean;
}) {
  return (
    <select
      aria-label={label}
      className="h-8 rounded-md border border-border bg-background px-2 text-[13px]"
      value={value}
      onChange={(e) => onChange(e.target.value as MemberRole | "inherit")}
    >
      {inherit && <option value="inherit">Same as everywhere</option>}
      {roles.map((r) => (
        <option key={r} value={r}>
          {ROLE_LABEL[r]}
        </option>
      ))}
    </select>
  );
}

/** Per-project overrides of a member's role (§B.3): raise or lower it, or hide a project. */
export function ProjectRolesEditor({
  value,
  onChange,
  roles,
}: {
  value: ProjectRoles;
  onChange: (next: ProjectRoles) => void;
  roles?: readonly MemberRole[];
}) {
  const projects = useSnapshotData((s) => s.projects, []);
  if (projects.length === 0) return null;
  return (
    <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-border p-2">
      {projects.map((p) => (
        <div key={p.id} className="flex items-center justify-between gap-3 text-[13px]">
          <span className="min-w-0 truncate">{p.name}</span>
          <RoleSelect
            label={`Role on ${p.name}`}
            inherit
            roles={roles}
            value={value[p.id] ?? "inherit"}
            onChange={(role) => {
              const next = { ...value };
              if (role === "inherit") delete next[p.id];
              else next[p.id] = role;
              onChange(next);
            }}
          />
        </div>
      ))}
    </div>
  );
}

/** The invite link: the secret rides in the fragment, which browsers never send to a server. */
export function inviteLink(secret: string): string {
  return `${serverOrigin}/join#${encodeURIComponent(secret)}`;
}

/** Settings › Members › Invite: a role, optional per-project roles, then a link shown once. */
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const [role, setRole] = useState<MemberRole>("viewer");
  const [projectRoles, setProjectRoles] = useState<ProjectRoles>({});
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<CreateInviteResponse | null>(null);
  const create = useMutation({
    mutationFn: () => client.members.createInvite({ role, projectRoles, note: note || undefined }),
    onSuccess: (res) => {
      setCreated(res);
      void queryClient.invalidateQueries({ queryKey: membersKey });
    },
    onError: (e) => toast.error("Invite not created", { description: e.message }),
  });
  const link = created ? inviteLink(created.secret) : "";
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="invite-dialog">
        <DialogHeader>
          <DialogTitle>Invite someone</DialogTitle>
          <DialogDescription>
            They open the link, pick a name and a passphrase, and are signed in. The link works
            once, for 7 days.
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input readOnly value={link} className="font-mono text-xs" />
              <Button
                variant="outline"
                onClick={() => void copyWithFeedback(link, "Invite link copied")}
              >
                <Copy /> Copy
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This is the only time the link is shown. Send it privately.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span className="font-medium">Role everywhere</span>
              <RoleSelect
                label="Role everywhere"
                value={role}
                onChange={(r) => setRole(r as MemberRole)}
              />
            </div>
            <div className="space-y-1.5">
              <div className="text-[13px] font-medium">Per project (optional)</div>
              <ProjectRolesEditor value={projectRoles} onChange={setProjectRoles} />
            </div>
            <Input
              placeholder="Note for yourself, e.g. who it's for"
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        )}
        <DialogFooter>
          {created ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending && <Loader2 className="animate-spin" />} Create link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
