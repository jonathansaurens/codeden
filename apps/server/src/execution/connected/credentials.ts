import { randomBytes, randomUUID } from "node:crypto";
import { CONNECT_CODE_PREFIX, CONNECT_CODE_TTL_MS, DEVICE_KEY_PREFIX } from "@codeden/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { machineCredentials } from "../../db/schema";
import { newSecret, sha256 } from "../../members/secrets";

/** A device key's `lastUsedAt` is written at most this often. */
const LAST_USED_WRITE_MS = 60_000;

/** A pairing code as its person follows it. */
export interface CodeRow {
  id: string;
  memberId: string;
  machineId: string | null;
  expiresAt: string;
  usedAt: string | null;
}

/** Why a pairing code can't be used. */
export type RedeemRefusal = "unknown" | "used" | "expired";

/**
 * Pairing codes and device keys (§D.5), as SHA-256 hashes in `machine_credentials`. A code has
 * 120 random bits and lives 10 minutes; a key has 256 and lives until its computer is
 * disconnected, when it is revoked (never deleted).
 */
export class ConnectCredentials {
  private readonly lastUsedWritten = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new single-use pairing code for `memberId`. */
  createCode(memberId: string): { id: string; code: string; expiresAt: string } {
    const code = `${CONNECT_CODE_PREFIX}${randomBytes(15).toString("base64url")}`;
    const id = randomUUID();
    const expiresAt = new Date(this.now() + CONNECT_CODE_TTL_MS).toISOString();
    this.db
      .insert(machineCredentials)
      .values({
        id,
        kind: "code",
        hash: sha256(code),
        memberId,
        machineId: null,
        createdAt: this.iso(),
        expiresAt,
        usedAt: null,
        lastUsedAt: null,
        revokedAt: null,
      })
      .run();
    return { id, code, expiresAt };
  }

  /** A code by id, if it is `memberId`'s. */
  code(id: string, memberId: string): CodeRow | undefined {
    const row = this.db
      .select()
      .from(machineCredentials)
      .where(and(eq(machineCredentials.id, id), eq(machineCredentials.kind, "code")))
      .get();
    if (!row || row.memberId !== memberId) return undefined;
    return {
      id: row.id,
      memberId: row.memberId,
      machineId: row.machineId,
      expiresAt: row.expiresAt ?? this.iso(),
      usedAt: row.usedAt,
    };
  }

  /** Whether a code has run out without being used. */
  expired(code: CodeRow): boolean {
    return !code.usedAt && Date.parse(code.expiresAt) <= this.now();
  }

  /**
   * Use a pairing code once: the code's row is marked used in the same statement that checks it
   * isn't, so two computers racing with one code can't both get a key.
   */
  redeem(code: string): { codeId: string; memberId: string } | { refused: RedeemRefusal } {
    if (!code.startsWith(CONNECT_CODE_PREFIX)) return { refused: "unknown" };
    const row = this.db
      .select()
      .from(machineCredentials)
      .where(and(eq(machineCredentials.hash, sha256(code)), eq(machineCredentials.kind, "code")))
      .get();
    if (!row || row.revokedAt) return { refused: "unknown" };
    if (row.usedAt) return { refused: "used" };
    if (!row.expiresAt || Date.parse(row.expiresAt) <= this.now()) return { refused: "expired" };
    const marked = this.db
      .update(machineCredentials)
      .set({ usedAt: this.iso() })
      .where(and(eq(machineCredentials.id, row.id), isNull(machineCredentials.usedAt)))
      .run();
    if (marked.changes === 0) return { refused: "used" };
    return { codeId: row.id, memberId: row.memberId };
  }

  /** Note which machine a used code paired. */
  attachCode(codeId: string, machineId: string): void {
    this.db
      .update(machineCredentials)
      .set({ machineId })
      .where(eq(machineCredentials.id, codeId))
      .run();
  }

  /** A new device key for a machine; its earlier keys are revoked (one computer, one key). */
  createKey(memberId: string, machineId: string): string {
    this.revokeMachine(machineId);
    const key = newSecret(DEVICE_KEY_PREFIX);
    this.db
      .insert(machineCredentials)
      .values({
        id: randomUUID(),
        kind: "key",
        hash: sha256(key),
        memberId,
        machineId,
        createdAt: this.iso(),
        expiresAt: null,
        usedAt: null,
        lastUsedAt: null,
        revokedAt: null,
      })
      .run();
    return key;
  }

  /** The machine and person of a live device key, or undefined. Notes the use. */
  verifyKey(key: string | undefined): { machineId: string; memberId: string } | undefined {
    if (!key?.startsWith(DEVICE_KEY_PREFIX)) return undefined;
    const row = this.db
      .select()
      .from(machineCredentials)
      .where(
        and(
          eq(machineCredentials.hash, sha256(key)),
          eq(machineCredentials.kind, "key"),
          isNull(machineCredentials.revokedAt),
        ),
      )
      .get();
    if (!row?.machineId) return undefined;
    const now = this.now();
    if (now - (this.lastUsedWritten.get(row.id) ?? 0) >= LAST_USED_WRITE_MS) {
      this.lastUsedWritten.set(row.id, now);
      this.db
        .update(machineCredentials)
        .set({ lastUsedAt: new Date(now).toISOString() })
        .where(eq(machineCredentials.id, row.id))
        .run();
    }
    return { machineId: row.machineId, memberId: row.memberId };
  }

  /** Revoke every live key of a machine. */
  revokeMachine(machineId: string): void {
    this.db
      .update(machineCredentials)
      .set({ revokedAt: this.iso() })
      .where(
        and(
          eq(machineCredentials.machineId, machineId),
          eq(machineCredentials.kind, "key"),
          isNull(machineCredentials.revokedAt),
        ),
      )
      .run();
  }

  /** Revoke a member's unused codes (they were deleted). */
  revokeMemberCodes(memberId: string): void {
    this.db
      .update(machineCredentials)
      .set({ revokedAt: this.iso() })
      .where(
        and(
          eq(machineCredentials.memberId, memberId),
          eq(machineCredentials.kind, "code"),
          isNull(machineCredentials.usedAt),
          isNull(machineCredentials.revokedAt),
        ),
      )
      .run();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}
