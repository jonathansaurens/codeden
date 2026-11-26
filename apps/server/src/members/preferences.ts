import { ROLE_ON_SERVER, type RoleRunsOn } from "@codeden/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { memberPreferences } from "../db/schema";

/**
 * Each person's own preferences (`member_preferences`): where their orchestrator runs
 * (`docs/machines-teams-and-agents.md` §D.4). A person's choice for their own work, so it is
 * written directly rather than as an event the UI streams to everyone.
 */
export class MemberPreferences {
  constructor(private readonly db: Db) {}

  /** Where the member's orchestrator runs: `server` (the default) or a machine's id. */
  orchestratorRunsOn(memberId: string): RoleRunsOn {
    const row = this.db
      .select({ runsOn: memberPreferences.orchestratorRunsOn })
      .from(memberPreferences)
      .where(eq(memberPreferences.memberId, memberId))
      .get();
    return row?.runsOn ?? ROLE_ON_SERVER;
  }

  setOrchestratorRunsOn(memberId: string, runsOn: RoleRunsOn): void {
    const updatedAt = new Date().toISOString();
    this.db
      .insert(memberPreferences)
      .values({ memberId, orchestratorRunsOn: runsOn, updatedAt })
      .onConflictDoUpdate({
        target: memberPreferences.memberId,
        set: { orchestratorRunsOn: runsOn, updatedAt },
      })
      .run();
  }

  /** The member was deleted: their preferences go with them. */
  forget(memberId: string): void {
    this.db.delete(memberPreferences).where(eq(memberPreferences.memberId, memberId)).run();
  }
}
