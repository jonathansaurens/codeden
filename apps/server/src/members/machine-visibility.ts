import type { Member, RawEventEnvelope, RunnerRecord } from "@codeden/contracts";

/**
 * Who sees a connected computer (`docs/machines-teams-and-agents.md` §D.5): its person, and the
 * server's Owners (who may disconnect it). Everyone else never learns it exists: not in
 * `GET /api/machines`, the snapshot's runners or the live runner events. Machines over SSH are
 * the server's and everyone sees them.
 */
export function seesMachine(member: Member | undefined, owner: string | null | undefined): boolean {
  if (!owner || !member) return true;
  if (member.kind === "person" && member.id === owner) return true;
  return !member.disabled && member.role === "owner";
}

/**
 * Whether a runner event may reach this member: a record's registration names its owner; the
 * connection events name the record by id (`ownerOf` looks it up).
 */
export function seesRunnerEvent(
  member: Member,
  e: RawEventEnvelope,
  ownerOf: (recordId: string) => string | null | undefined,
): boolean {
  if (!e.type.startsWith("runner.")) return true;
  const payload = e.payload as { runner?: RunnerRecord; id?: string } | null;
  if (payload?.runner) return seesMachine(member, payload.runner.ownerMemberId);
  return payload?.id ? seesMachine(member, ownerOf(payload.id)) : true;
}
