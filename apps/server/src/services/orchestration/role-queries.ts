import type { RoleSessionsRef, Session } from "@codeden/contracts";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToSession } from "../../db/rows";
import { sessions } from "../../db/schema";
import { personKey } from "./role-keys";

/** Reads of the role sessions (§8.1) for `RoleSessions`. A retired one is archived. */

/**
 * The current session of a role (the latest that isn't retired), if any. `of` is what the role
 * belongs to: the PM's project, or the orchestrator's person (`personKey`, null: the first owner).
 */
export function findRoleSession(
  db: Db,
  role: "orchestrator" | "pm",
  of: string | null,
): Session | undefined {
  if (role === "pm" && !of) return undefined;
  const person = personKey(of);
  const row = db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.role, role),
        isNull(sessions.archivedAt),
        role === "orchestrator"
          ? and(
              isNull(sessions.projectId),
              person ? eq(sessions.ownerMemberId, person) : isNull(sessions.ownerMemberId),
            )
          : eq(sessions.projectId, of as string),
      ),
    )
    .orderBy(desc(sessions.createdAt))
    .limit(1)
    .get();
  return row ? rowToSession(row) : undefined;
}

/** Ids of every orchestrator and PM session, retired ones included. */
export function allRoleSessionIds(db: Db): Set<string> {
  const rows = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.role, ["orchestrator", "pm"]))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** The current role sessions (not retired), orchestrators and PMs, oldest first. */
function currentRoleSessions(db: Db): Session[] {
  return db
    .select()
    .from(sessions)
    .where(and(inArray(sessions.role, ["orchestrator", "pm"]), isNull(sessions.archivedAt)))
    .orderBy(sessions.createdAt)
    .all()
    .map(rowToSession);
}

/**
 * The current role sessions as one person sees them: their own orchestrator (`person`, a person
 * key; null: the first owner) and each project's PM.
 */
export function roleSessionRefs(db: Db, person: string | null = null): RoleSessionsRef {
  const ref: RoleSessionsRef = { orchestrator: null, pms: {} };
  for (const s of currentRoleSessions(db)) {
    if (s.role === "orchestrator") {
      if (personKey(s.ownerMemberId) === personKey(person)) ref.orchestrator = s.id;
    } else if (s.projectId) ref.pms[s.projectId] = s.id;
  }
  return ref;
}

/** Every person's current orchestrator session id, by person key (null: the first owner). */
export function orchestratorRefs(db: Db): Map<string | null, string> {
  const refs = new Map<string | null, string>();
  for (const s of currentRoleSessions(db)) {
    if (s.role === "orchestrator") refs.set(personKey(s.ownerMemberId), s.id);
  }
  return refs;
}
