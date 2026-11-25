import { type MemberDetail, type MemberRole, OWNER_MEMBER_ID } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, LogOut, Trash2, UserPlus, UserRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/api";
import { ago, until } from "@/lib/format";
import { memberName, membersKey, ROLE_LABEL, useCan, useMemberNames } from "@/lib/members";
import { AddAgentDialog, TokenOnce } from "./agent-dialog";
import { InviteDialog, ProjectRolesEditor, RoleSelect } from "./member-dialogs";
import { deviceName } from "./sections-network";
import { SettingRow, SettingsSection } from "./settings-ui";

/**
 * Settings › Members (§B.2): everyone who can use this server, their roles (server-wide and per
 * project), their devices, invites, disabling and deleting. Owners only; others see who is here.
 */
export function MembersSettings() {
  const client = useClient();
  const isOwner = useCan("owner", undefined);
  const [inviting, setInviting] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  const list = useQuery({
    queryKey: membersKey,
    queryFn: () => client.members.list(),
    enabled: isOwner,
  });
  if (!isOwner) {
    return (
      <SettingsSection title="Members">
        <SettingRow
          label="Only owners manage members"
          help="Ask an owner to invite someone or change roles."
        >
          <span />
        </SettingRow>
      </SettingsSection>
    );
  }
  const members = list.data?.members ?? [];
  const invites = (list.data?.invites ?? []).filter(
    (i) => !i.usedAt && !i.revokedAt && Date.parse(i.expiresAt) > Date.now(),
  );
  return (
    <>
      <SettingsSection
        title="Members"
        description="People sign in with their own passphrase. Roles apply everywhere, and can be raised or lowered per project; a project where someone has no role is hidden from them."
      >
        <div className="flex flex-wrap gap-2 px-4 py-3">
          <Button size="sm" onClick={() => setInviting(true)} data-testid="invite-member">
            <UserPlus /> Invite someone
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddingAgent(true)}
            data-testid="add-agent"
          >
            <Bot /> Add agent
          </Button>
        </div>
        {members.map((d) => (
          <MemberRow key={d.member.id} detail={d} />
        ))}
      </SettingsSection>
      {invites.length > 0 && (
        <SettingsSection title="Open invites">
          {invites.map((i) => (
            <InviteRow key={i.id} id={i.id} role={i.role} note={i.note} expiresAt={i.expiresAt} />
          ))}
        </SettingsSection>
      )}
      <ActivityList />
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
      {addingAgent && <AddAgentDialog onClose={() => setAddingAgent(false)} />}
    </>
  );
}

const ACTIVITY_LABEL: Record<string, string> = {
  "settings.updated": "Changed settings",
  "member.created": "Added a member",
  "member.updated": "Changed a member",
  "member.deleted": "Deleted a member",
  "session.created": "Started a session",
  "session.updated": "Changed a session",
  "message.queued": "Queued a message",
  "inbox.updated": "Answered or closed an inbox item",
  "project.created": "Added a project",
  "project.updated": "Changed a project",
  "project.archived": "Archived a project",
  "automation.saved": "Saved an automation",
  "automation.deleted": "Deleted an automation",
  "automation_run.updated": "Ran an automation",
};

/** Who did what lately (§B.4): settings changes, stops, answers and more. */
function ActivityList() {
  const client = useClient();
  const names = useMemberNames();
  const activity = useQuery({
    queryKey: ["members", "activity"],
    queryFn: () => client.members.activity(),
  });
  const events = activity.data?.events ?? [];
  if (events.length === 0) return null;
  return (
    <SettingsSection
      title="Recent activity"
      description="The latest changes people and connected agents made."
    >
      <ul className="divide-y divide-border">
        {events.slice(0, 30).map((e) => (
          <li key={e.seq} className="flex items-center justify-between gap-3 px-4 py-2 text-[13px]">
            <span className="min-w-0 truncate">
              <span className="font-medium">{memberName(names, e.actor.memberId)}</span>{" "}
              <span className="text-muted-foreground">
                {(ACTIVITY_LABEL[e.type] ?? e.type).toLowerCase()}
              </span>
            </span>
            <span className="shrink-0 text-2xs text-muted-foreground">{ago(e.ts)}</span>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}

function InviteRow(props: {
  id: string;
  role: MemberRole;
  note: string | null;
  expiresAt: string;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => client.members.revokeInvite(props.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: membersKey }),
  });
  return (
    <SettingRow
      label={`${ROLE_LABEL[props.role]} invite${props.note ? ` · ${props.note}` : ""}`}
      help={`Works for ${until(props.expiresAt)}`}
    >
      <Button size="xs" variant="outline" onClick={() => revoke.mutate()}>
        Revoke
      </Button>
    </SettingRow>
  );
}

function MemberRow({ detail }: { detail: MemberDetail }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const { member } = detail;
  const first = member.id === OWNER_MEMBER_ID;
  const agent = member.kind === "agent";
  const [editingProjects, setEditingProjects] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["members"] });
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof client.members.update>[1]) =>
      client.members.update(member.id, patch),
    onSuccess: refresh,
    onError: (e) => toast.error("Member not changed", { description: e.message }),
  });
  const remove = useMutation({
    mutationFn: () => client.members.remove(member.id),
    onSuccess: refresh,
    onError: (e) => toast.error("Member not deleted", { description: e.message }),
  });
  const signOut = useMutation({
    mutationFn: (deviceId: string) => client.members.signOutDevice(member.id, deviceId),
    onSuccess: refresh,
  });
  const overrides = Object.keys(member.projectRoles).length;
  return (
    <div className="space-y-3 px-4 py-3.5" data-testid="member-row">
      <div className="flex flex-wrap items-center gap-3">
        {agent ? <Bot className="size-4 text-primary" /> : <UserRound className="size-4" />}
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">
            {member.name}
            {agent && <span className="ml-2 text-2xs text-muted-foreground">Connected agent</span>}
            {member.disabled && <span className="ml-2 text-2xs text-destructive">Disabled</span>}
          </div>
          <div className="text-2xs text-muted-foreground">
            {first
              ? "First owner · uses the network access password"
              : `Added ${ago(member.createdAt)}`}
            {overrides > 0 && ` · ${overrides} project ${overrides === 1 ? "role" : "roles"}`}
          </div>
        </div>
        <RoleSelect
          label={`Role of ${member.name}`}
          value={member.role}
          roles={agent ? ["none", "viewer", "operator"] : undefined}
          onChange={(role) => !first && update.mutate({ role: role as MemberRole })}
        />
        {!first && (
          <>
            <Button size="xs" variant="outline" onClick={() => setEditingProjects((v) => !v)}>
              Projects
            </Button>
            <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Switch
                checked={!member.disabled}
                onCheckedChange={(on) => update.mutate({ disabled: !on })}
                aria-label={`${member.name} enabled`}
              />
              Enabled
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Delete ${member.name}`}
              onClick={() => {
                if (window.confirm(`Delete ${member.name}? Their devices are signed out.`))
                  remove.mutate();
              }}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>
      {editingProjects && (
        <ProjectRolesEditor
          value={member.projectRoles}
          roles={agent ? ["none", "viewer", "operator"] : undefined}
          onChange={(projectRoles) => update.mutate({ projectRoles })}
        />
      )}
      {agent && <AgentControls detail={detail} onChange={refresh} />}
      {detail.devices.length > 0 && (
        <ul className="space-y-1 pl-7">
          {detail.devices.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 text-2xs">
              <span className="min-w-0 truncate text-muted-foreground">
                {deviceName(d.label)} · {d.address ?? "unknown address"} · seen {ago(d.lastSeenAt)}
              </span>
              <Button size="xs" variant="ghost" onClick={() => signOut.mutate(d.id)}>
                <LogOut /> Sign out
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A connected agent's approval switch and tokens: last used, revoke, and a new one (§C.1). */
function AgentControls({ detail, onChange }: { detail: MemberDetail; onChange: () => void }) {
  const client = useClient();
  const { member } = detail;
  const [fresh, setFresh] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (mayAnswerApprovals: boolean) =>
      client.members.update(member.id, { mayAnswerApprovals }),
    onSuccess: onChange,
  });
  const mint = useMutation({
    mutationFn: () => client.members.mintToken(member.id),
    onSuccess: (res) => {
      setFresh(res.token);
      onChange();
    },
  });
  const revoke = useMutation({
    mutationFn: (tokenId: string) => client.members.revokeToken(member.id, tokenId),
    onSuccess: onChange,
  });
  const live = detail.tokens.filter((t) => !t.revokedAt);
  return (
    <div className="space-y-2 pl-7">
      <div className="flex items-center justify-between gap-2 text-2xs">
        <span className="text-muted-foreground">May answer approvals</span>
        <Switch
          checked={member.mayAnswerApprovals}
          onCheckedChange={(on) => update.mutate(on)}
          aria-label={`${member.name} may answer approvals`}
        />
      </div>
      <ul className="space-y-1">
        {live.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-2 text-2xs">
            <span className="text-muted-foreground">
              Token from {ago(t.createdAt)} ·{" "}
              {t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : "never used"}
            </span>
            <Button size="xs" variant="ghost" onClick={() => revoke.mutate(t.id)}>
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      {fresh ? (
        <TokenOnce token={fresh} />
      ) : (
        <Button size="xs" variant="outline" onClick={() => mint.mutate()}>
          New token
        </Button>
      )}
    </div>
  );
}
