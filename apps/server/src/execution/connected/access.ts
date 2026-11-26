import { type Member, memberRoleOn, type RunnerRecord } from "@codeden/contracts";
import type { Principal } from "../../members/principal";

type MemberLookup = (id: string) => Member | undefined;

/** "Alice's computer (alice-mbp)" for a person's own computer, else the machine's label. */
export function computerName(record: RunnerRecord, member: MemberLookup): string {
  const label = record.label ?? record.id;
  if (!record.ownerMemberId) return label;
  const owner = member(record.ownerMemberId);
  return owner ? `${owner.name}'s computer (${label})` : label;
}

/**
 * Why work being placed now may not go to `record`, or null when it may
 * (`docs/machines-teams-and-agents.md` §D.5). A person's own computer takes work only from that
 * person: the sessions they start, and work nobody in particular started (a PM, an automation:
 * no `principal`) only when they are an Owner of its project. Anyone else, connected agents
 * included, is refused. Machines over SSH take anyone's work.
 */
export function placementRefusal(
  record: RunnerRecord,
  projectId: string | null,
  member: MemberLookup,
  principal: Principal | undefined,
): string | null {
  const ownerId = record.ownerMemberId;
  if (!ownerId) return null;
  const owner = member(ownerId);
  const name = computerName(record, member);
  if (!owner || owner.disabled) return `${name} can't take work: its person is gone`;
  if (principal) {
    return principal.member.id === ownerId
      ? null
      : `${name} is ${owner.name}'s own computer; only they can run sessions there`;
  }
  if (projectId && memberRoleOn(owner, projectId) === "owner") return null;
  return `${name} is ${owner.name}'s own computer; it takes only work they start`;
}
