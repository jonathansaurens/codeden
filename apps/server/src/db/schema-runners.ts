import type { RunnerBackendId, RunnerRecordState } from "@codeden/contracts";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
