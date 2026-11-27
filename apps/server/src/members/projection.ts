import { type EventOf, Member } from "@codeden/contracts";
import { eq } from "drizzle-orm";
import { memberCredentials, members } from "../db/schema";
import type { Tx } from "../events/projection-db";

type MemberRow = typeof members.$inferSelect;

export function memberToRow(m: Member): MemberRow {
  return {
    id: m.id,
    kind: m.kind,
    name: m.name,
    role: m.role,
    projectRoles: m.projectRoles,
    disabled: m.disabled,
    mayAnswerApprovals: m.mayAnswerApprovals,
    createdBy: m.createdBy,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

export function rowToMember(row: MemberRow): Member {
  return Member.parse({ ...row, projectRoles: row.projectRoles ?? {} });
}

/** `members` from `member.*` events, in the append transaction (§6). */
export function applyMemberProjection(
  tx: Tx,
  e: EventOf<"member.created" | "member.updated" | "member.deleted">,
): void {
  if (e.type === "member.deleted") {
    tx.delete(members).where(eq(members.id, e.payload.memberId)).run();
    // Its secrets go with it (they are not projections, but nothing may outlive the member).
    tx.delete(memberCredentials).where(eq(memberCredentials.memberId, e.payload.memberId)).run();
    return;
  }
  const row = memberToRow(e.payload.member);
  tx.insert(members).values(row).onConflictDoUpdate({ target: members.id, set: row }).run();
}
