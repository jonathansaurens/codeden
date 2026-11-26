import type { MemberKind, MemberRole, ProjectRoles } from "@codeden/contracts";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Members (docs/machines-teams-and-agents.md Part B, C). `members` is a projection of the
 * `member.*` events. `member_credentials` and `member_invites` hold secrets (only their SHA-256
 * or scrypt hashes), so they are written directly, like `mcp_tokens`, and never enter the event
 * log, which the UI streams. The first owner's passphrase stays the network password in
 * `remote-access.json`, where it always was.
 */

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const members = sqliteTable(
  "members",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<MemberKind>().notNull(),
    name: text("name").notNull(),
    role: text("role").$type<MemberRole>().notNull(),
    projectRoles: json<ProjectRoles>("project_roles").notNull(),
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    mayAnswerApprovals: integer("may_answer_approvals", { mode: "boolean" })
      .notNull()
      .default(false),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("members_name").on(t.name)],
);

/**
 * A person's passphrase (scrypt) or an agent's token (SHA-256). A token is revoked, never
 * deleted, so its last use stays visible; deleting the member deletes its rows.
 */
export const memberCredentials = sqliteTable(
  "member_credentials",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id").notNull(),
    kind: text("kind").$type<"passphrase" | "token">().notNull(),
    hash: text("hash").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    index("member_credentials_member").on(t.memberId),
    uniqueIndex("member_credentials_hash").on(t.hash),
  ],
);

/** Invites: the SHA-256 of a single-use secret, valid for 7 days. */
export const memberInvites = sqliteTable(
  "member_invites",
  {
    id: text("id").primaryKey(),
    secretHash: text("secret_hash").notNull(),
    role: text("role").$type<MemberRole>().notNull(),
    projectRoles: json<ProjectRoles>("project_roles").notNull(),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    usedBy: text("used_by"),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("member_invites_secret").on(t.secretHash)],
);

/**
 * A member's own preferences, written directly (a person's choice for their own work, never
 * shared): where their orchestrator runs (`RoleRunsOn`, `docs/machines-teams-and-agents.md`
 * §D.4). No row: the defaults. The first owner's row is keyed by `OWNER_MEMBER_ID`.
 */
export const memberPreferences = sqliteTable("member_preferences", {
  memberId: text("member_id").primaryKey(),
  orchestratorRunsOn: text("orchestrator_runs_on").notNull().default("server"),
  updatedAt: text("updated_at").notNull(),
});
