import { randomUUID } from "node:crypto";
import {
  AGENT_TOKEN_PREFIX,
  type AgentTokenInfo,
  type CreateAgentRequest,
  type Member,
  type MemberRole,
  OWNER_MEMBER_ID,
  type ProjectRoles,
  passwordProblem,
  type UpdateMemberRequest,
} from "@codeden/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { memberCredentials, members } from "../db/schema";
import type { Tx } from "../events/projection-db";
import type { EventStore } from "../events/store";
import { hashPassword, verifyPassword } from "../network/password";
import { badRequest, conflict, forbidden, notFound } from "../services/errors";
import { nameKey, nameProblem, normalizeName } from "./names";
import { rowToMember } from "./projection";
import { newSecret, sha256 } from "./secrets";

/** A token's `lastUsedAt` is written at most this often. */
const LAST_USED_WRITE_MS = 60_000;

/** A well-formed scrypt hash nothing matches, checked when there is no member to check. */
const NO_MATCH_HASH = `scrypt$32768$8$1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(32).toString("base64")}`;

/** The name the first owner starts with (they can change it in Settings › Members). */
export const DEFAULT_OWNER_NAME = "Owner";

/** The first owner as it is until changed (not stored until then). */
const DEFAULT_OWNER: Member = {
  id: OWNER_MEMBER_ID,
  kind: "person",
  name: DEFAULT_OWNER_NAME,
  role: "owner",
  projectRoles: {},
  disabled: false,
  mayAnswerApprovals: false,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

export interface MemberServiceOptions {
  db: Db;
  store: EventStore;
  now?: () => number;
}

/**
 * Members (Part B, C): the first owner, people who joined with an invite and connected agents.
 * Member records are event-sourced (`member.*`); their secrets (passphrase and token hashes) are
 * written straight to `member_credentials`. Kept in memory as well: every request looks its
 * member up.
 */
export class MemberService {
  private readonly db: Db;
  private readonly store: EventStore;
  private readonly now: () => number;
  private cache = new Map<string, Member>();
  private readonly lastUsedWritten = new Map<string, number>();

  constructor(opts: MemberServiceOptions) {
    this.db = opts.db;
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.reload();
    this.store.subscribe((events) => {
      if (events.some((e) => e.type.startsWith("member."))) this.reload();
    });
  }

  /**
   * The first owner. Every install has one (the install token acts as it); until someone changes
   * it, it is the default below and nothing is stored, so a single-user install writes nothing.
   */
  owner(): Member {
    return this.cache.get(OWNER_MEMBER_ID) ?? DEFAULT_OWNER;
  }

  /** Every member, the first owner first, then by when they were added. */
  list(): Member[] {
    const others = [...this.cache.values()]
      .filter((m) => m.id !== OWNER_MEMBER_ID)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return [this.owner(), ...others];
  }

  /** More than the first owner: the UI shows names, presence and the sign-in name field. */
  isTeam(): boolean {
    return [...this.cache.keys()].some((id) => id !== OWNER_MEMBER_ID);
  }

  find(id: string): Member | undefined {
    return id === OWNER_MEMBER_ID ? this.owner() : this.cache.get(id);
  }

  get(id: string): Member {
    const member = this.find(id);
    if (!member) throw notFound("No such member", "member_not_found");
    return member;
  }

  /** The person with this display name (any case), if any. */
  findPersonByName(name: string): Member | undefined {
    const wanted = nameKey(name);
    return this.list().find((m) => m.kind === "person" && nameKey(m.name) === wanted);
  }

  /**
   * Names are unique across members, compared as they look (`nameKey`: any case, compatibility
   * forms and look-alike letters folded), so sign-in by name is never ambiguous and nobody can
   * pass for someone else. A name with invisible characters or mixed scripts is refused.
   */
  assertNameFree(name: string, except?: string): void {
    const problem = nameProblem(name);
    if (problem) throw badRequest(problem, "name_invalid");
    const wanted = nameKey(name);
    if (this.list().some((m) => m.id !== except && nameKey(m.name) === wanted)) {
      throw conflict("Another member already has that name.", "name_taken");
    }
  }

  /**
   * Add a person who took an invite. `extra` runs in the same transaction (the invite is marked
   * used there), so an invite can never create two members.
   */
  addPerson(
    input: { name: string; role: MemberRole; projectRoles: ProjectRoles; createdBy: string },
    passphraseHash: string,
    extra: (tx: Tx, id: string) => void,
  ): Member {
    this.assertNameFree(input.name);
    const at = this.iso();
    const member: Member = {
      id: randomUUID(),
      kind: "person",
      name: normalizeName(input.name),
      role: input.role,
      projectRoles: input.projectRoles,
      disabled: false,
      mayAnswerApprovals: false,
      createdBy: input.createdBy,
      createdAt: at,
      updatedAt: at,
    };
    this.store.append([{ type: "member.created", sessionId: null, payload: { member } }], (tx) => {
      extra(tx, member.id);
      tx.insert(memberCredentials)
        .values({
          id: randomUUID(),
          memberId: member.id,
          kind: "passphrase",
          hash: passphraseHash,
          createdAt: at,
          lastUsedAt: null,
          revokedAt: null,
        })
        .run();
    });
    return member;
  }

  /** Settings › Members › Add agent: a connected agent and its first token (shown once). */
  addAgent(req: CreateAgentRequest, createdBy: string): { member: Member; token: string } {
    this.assertNameFree(req.name);
    const at = this.iso();
    const member: Member = {
      id: randomUUID(),
      kind: "agent",
      name: normalizeName(req.name),
      role: req.role,
      projectRoles: req.projectRoles,
      disabled: false,
      mayAnswerApprovals: req.mayAnswerApprovals,
      createdBy,
      createdAt: at,
      updatedAt: at,
    };
    const token = newSecret(AGENT_TOKEN_PREFIX);
    this.store.append([{ type: "member.created", sessionId: null, payload: { member } }], (tx) => {
      tx.insert(memberCredentials)
        .values(this.tokenRow(member.id, token, at))
        .run();
    });
    return { member, token };
  }

  /** A new token for an agent (the old ones keep working until revoked). */
  mintToken(memberId: string): string {
    const member = this.get(memberId);
    if (member.kind !== "agent") throw badRequest("Only connected agents have tokens.");
    const token = newSecret(AGENT_TOKEN_PREFIX);
    this.db
      .insert(memberCredentials)
      .values(this.tokenRow(memberId, token, this.iso()))
      .run();
    return token;
  }

  revokeToken(memberId: string, tokenId: string): void {
    const result = this.db
      .update(memberCredentials)
      .set({ revokedAt: this.iso() })
      .where(
        and(
          eq(memberCredentials.id, tokenId),
          eq(memberCredentials.memberId, memberId),
          eq(memberCredentials.kind, "token"),
          isNull(memberCredentials.revokedAt),
        ),
      )
      .run();
    if (result.changes === 0) throw notFound("No such token", "token_not_found");
  }

  tokens(memberId: string): AgentTokenInfo[] {
    return this.db
      .select()
      .from(memberCredentials)
      .where(and(eq(memberCredentials.memberId, memberId), eq(memberCredentials.kind, "token")))
      .all()
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        revokedAt: r.revokedAt,
      }));
  }

  hasPassphrase(memberId: string): boolean {
    return this.passphraseRow(memberId) !== undefined;
  }

  /**
   * The member a live agent token belongs to, or undefined (unknown, revoked, or its member is
   * gone or disabled). Notes the use.
   */
  verifyToken(token: string | undefined): { member: Member; tokenId: string } | undefined {
    if (!token?.startsWith(AGENT_TOKEN_PREFIX)) return undefined;
    const row = this.db
      .select()
      .from(memberCredentials)
      .where(
        and(
          eq(memberCredentials.hash, sha256(token)),
          eq(memberCredentials.kind, "token"),
          isNull(memberCredentials.revokedAt),
        ),
      )
      .get();
    const member = row ? this.find(row.memberId) : undefined;
    if (!row || !member || member.disabled || member.kind !== "agent") return undefined;
    const now = this.now();
    if (now - (this.lastUsedWritten.get(row.id) ?? 0) >= LAST_USED_WRITE_MS) {
      this.lastUsedWritten.set(row.id, now);
      this.db
        .update(memberCredentials)
        .set({ lastUsedAt: new Date(now).toISOString() })
        .where(eq(memberCredentials.id, row.id))
        .run();
    }
    return { member, tokenId: row.id };
  }

  /**
   * Check a person's passphrase (not the first owner's: that is the network password). An
   * unknown member costs a hash all the same, so names can't be probed by timing.
   */
  async checkPassphrase(memberId: string, password: string): Promise<boolean> {
    const row = this.passphraseRow(memberId);
    const match = await verifyPassword(password, row?.hash ?? NO_MATCH_HASH);
    return row !== undefined && match;
  }

  /** Hash a new member's passphrase after checking the rules (throws a 400 with the reason). */
  async hashPassphrase(password: string): Promise<string> {
    const problem = passwordProblem(password);
    if (problem) throw badRequest(problem, "weak_password");
    return hashPassword(password);
  }

  /** Change a member (owners). The first owner always stays an enabled owner. */
  update(id: string, patch: UpdateMemberRequest): Member {
    const member = this.get(id);
    if (id === OWNER_MEMBER_ID) {
      if ((patch.role && patch.role !== "owner") || patch.disabled) {
        throw forbidden("The first owner always stays an owner.", "owner_locked");
      }
    }
    if (patch.name !== undefined) this.assertNameFree(patch.name, id);
    if (member.kind === "agent") assertAgentRoles(patch.role, patch.projectRoles);
    if (member.kind === "person" && patch.mayAnswerApprovals !== undefined) {
      throw badRequest("Only connected agents have that setting.");
    }
    const next: Member = {
      ...member,
      ...(patch.name !== undefined ? { name: normalizeName(patch.name) } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.projectRoles !== undefined ? { projectRoles: patch.projectRoles } : {}),
      ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
      ...(patch.mayAnswerApprovals !== undefined
        ? { mayAnswerApprovals: patch.mayAnswerApprovals }
        : {}),
      updatedAt: this.iso(),
    };
    this.store.append([{ type: "member.updated", sessionId: null, payload: { member: next } }]);
    return next;
  }

  /** Delete a member and its secrets (its devices are signed out by the caller). */
  delete(id: string): void {
    if (id === OWNER_MEMBER_ID)
      throw forbidden("The first owner can't be deleted.", "owner_locked");
    this.get(id);
    this.store.append([{ type: "member.deleted", sessionId: null, payload: { memberId: id } }]);
  }

  private passphraseRow(memberId: string) {
    return this.db
      .select()
      .from(memberCredentials)
      .where(
        and(
          eq(memberCredentials.memberId, memberId),
          eq(memberCredentials.kind, "passphrase"),
          isNull(memberCredentials.revokedAt),
        ),
      )
      .get();
  }

  private tokenRow(memberId: string, token: string, at: string) {
    return {
      id: randomUUID(),
      memberId,
      kind: "token" as const,
      hash: sha256(token),
      createdAt: at,
      lastUsedAt: null,
      revokedAt: null,
    };
  }

  private reload(): void {
    const next = new Map<string, Member>();
    for (const row of this.db.select().from(members).all()) next.set(row.id, rowToMember(row));
    this.cache = next;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** Agents are never owners (§C.1), server-wide or on a project. */
export function assertAgentRoles(role?: MemberRole, projectRoles?: ProjectRoles): void {
  if (role === "owner" || Object.values(projectRoles ?? {}).includes("owner")) {
    throw badRequest("A connected agent can't be an owner.", "agent_owner");
  }
}
