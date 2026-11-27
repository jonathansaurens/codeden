import type { RunnerBackendId, RunnerRecordState } from "@codeden/contracts";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Runners the server drives (`docs/remote-runners.md` §8): the home runner and, in later
 * phases, one per sandboxed session. Projected from the `runner.*` lifecycle events in the
 * same transaction, so it can be rebuilt from the log. Ack positions stay in `runner_state`,
 * keyed by the runner's own id.
 */
export const runners = sqliteTable(
  "runners",
  {
    id: text("id").primaryKey(),
    backend: text("backend").$type<RunnerBackendId>().notNull(),
    isHome: integer("is_home", { mode: "boolean" }).notNull().default(false),
    /** The runner's journal id from its `welcome`; what `sessions.runner_id` holds. */
    runnerId: text("runner_id"),
    /** The sandbox's handle, or a machine's SSH destination. */
    sandboxRef: text("sandbox_ref"),
    /** A machine's label. */
    label: text("label"),
    /** A machine's (or the home runner's) preference for automatic placement; null: Normal. */
    weight: integer("weight"),
    /** The member whose own computer it is (a `connected` machine); null for other runners. */
    ownerMemberId: text("owner_member_id"),
    projectId: text("project_id"),
    sessionId: text("session_id"),
    state: text("state").$type<RunnerRecordState>().notNull(),
    version: text("version"),
    imageVersion: text("image_version"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at"),
    lastError: text("last_error"),
  },
  (t) => [index("runners_runner_id").on(t.runnerId)],
);

/**
 * Connecting your own computer (§D.5): pairing codes (single-use, valid for 10 minutes) and the
 * device keys computers trade them for. Only SHA-256 hashes of the secrets are stored, written
 * directly like `member_credentials` and never in the event log. A key is revoked, never
 * deleted, when its computer is disconnected.
 */
export const machineCredentials = sqliteTable(
  "machine_credentials",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<"code" | "key">().notNull(),
    hash: text("hash").notNull(),
    /** The person who asked for the code, and whose computer the key's machine is. */
    memberId: text("member_id").notNull(),
    /** The machine's record id: a key's always, a code's once it was used. */
    machineId: text("machine_id"),
    createdAt: text("created_at").notNull(),
    /** A code's expiry. */
    expiresAt: text("expires_at"),
    /** When a code was traded for a key. */
    usedAt: text("used_at"),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    uniqueIndex("machine_credentials_hash").on(t.hash),
    index("machine_credentials_machine").on(t.machineId),
  ],
);
