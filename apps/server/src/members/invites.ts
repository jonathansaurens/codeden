import { randomUUID } from "node:crypto";
import {
  type CreateInviteRequest,
  INVITE_DAYS,
  INVITE_SECRET_PREFIX,
  type Member,
  type MemberInvite,
} from "@codeden/contracts";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { memberInvites } from "../db/schema";
import { notFound, ServiceError } from "../services/errors";
import { newSecret, sha256 } from "./secrets";
import type { MemberService } from "./service";

const INVITE_MS = INVITE_DAYS * 24 * 60 * 60_000;

type InviteRow = typeof memberInvites.$inferSelect;

function rowToInvite(row: InviteRow): MemberInvite {
  return {
    id: row.id,
    role: row.role,
    projectRoles: row.projectRoles ?? {},
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    usedBy: row.usedBy,
    revokedAt: row.revokedAt,
  };
}

/** An invite that can't be used: unknown, used, revoked or expired. One answer for all four. */
export class InvalidInviteError extends ServiceError {
  constructor() {
    super(400, "invalid_invite", "This invite link doesn't work any more. Ask for a new one.");
  }
}

/**
 * Invites (§B.2): an owner creates one with a role and optional per-project roles; its link holds
 * a single-use secret valid for 7 days, stored only as a SHA-256 hash. Taking it creates the
 * member and marks it used in one transaction.
 */
export class InviteService {
  constructor(
    private readonly db: Db,
    private readonly members: MemberService,
    private readonly now: () => number = Date.now,
  ) {}

  create(req: CreateInviteRequest, createdBy: string): { invite: MemberInvite; secret: string } {
    const secret = newSecret(INVITE_SECRET_PREFIX);
    const now = this.now();
    const row: InviteRow = {
      id: randomUUID(),
      secretHash: sha256(secret),
      role: req.role,
      projectRoles: req.projectRoles,
      note: req.note || null,
      createdBy,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INVITE_MS).toISOString(),
      usedAt: null,
      usedBy: null,
      revokedAt: null,
    };
    this.db.insert(memberInvites).values(row).run();
    return { invite: rowToInvite(row), secret };
  }

  /** Every invite, newest first (owners). */
  list(): MemberInvite[] {
    return this.db
      .select()
      .from(memberInvites)
      .orderBy(desc(memberInvites.createdAt))
      .all()
      .map(rowToInvite);
  }

  revoke(id: string): void {
    const result = this.db
      .update(memberInvites)
      .set({ revokedAt: new Date(this.now()).toISOString() })
      .where(and(eq(memberInvites.id, id), isNull(memberInvites.revokedAt)))
      .run();
    if (result.changes === 0) throw notFound("No such invite", "invite_not_found");
  }

  /** The invite behind a secret while it can still be used; throws `InvalidInviteError`. */
  check(secret: string): MemberInvite {
    const row = this.usable(secret);
    if (!row) throw new InvalidInviteError();
    return rowToInvite(row);
  }

  /**
   * Take an invite: check the passphrase rules, hash it, then create the member and mark the
   * invite used in one transaction. The invite is checked again after the (slow) hashing, so
   * two joins racing with one secret create one member.
   */
  async join(input: { secret: string; name: string; password: string }): Promise<Member> {
    this.check(input.secret);
    this.members.assertNameFree(input.name);
    const hash = await this.members.hashPassphrase(input.password);
    const row = this.usable(input.secret);
    if (!row) throw new InvalidInviteError();
    const at = new Date(this.now()).toISOString();
    return this.members.addPerson(
      {
        name: input.name,
        role: row.role,
        projectRoles: row.projectRoles ?? {},
        createdBy: row.createdBy,
      },
      hash,
      (tx, memberId) => {
        const used = tx
          .update(memberInvites)
          .set({ usedAt: at, usedBy: memberId })
          .where(and(eq(memberInvites.id, row.id), isNull(memberInvites.usedAt)))
          .run();
        // Rolls the whole append back: nobody joins on an invite someone else just used.
        if (used.changes !== 1) throw new InvalidInviteError();
      },
    );
  }

  private usable(secret: string): InviteRow | undefined {
    if (!secret.startsWith(INVITE_SECRET_PREFIX)) return undefined;
    return this.db
      .select()
      .from(memberInvites)
      .where(
        and(
          eq(memberInvites.secretHash, sha256(secret)),
          isNull(memberInvites.usedAt),
          isNull(memberInvites.revokedAt),
          gt(memberInvites.expiresAt, new Date(this.now()).toISOString()),
        ),
      )
      .get();
  }
}
