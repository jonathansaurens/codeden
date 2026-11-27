import { type MemberRole, memberGlobalRole, memberRoleOn, roleAtLeast } from "@codeden/contracts";
import { z } from "zod";
import { invalidInputMessage } from "../../mcp/registry";
import type { AppServices } from "../../services/container";
import { errorMessage, ServiceError } from "../../services/errors";
import { authorize } from "../authorize";
import { type Principal, runAs } from "../principal";
import { isPrivateSession } from "../privacy";
import { authorizeContext } from "../sockets";
import type { AnyMemberTool } from "./define";
import {
  getDiff,
  getProjectStatus,
  getSession,
  listInbox,
  listProjects,
  listSessions,
  waitForSession,
} from "./read";
import {
  answerApproval,
  answerQuestion,
  messagePm,
  messageSession,
  runAutomation,
  startSession,
  stopSession,
} from "./work";

/** Every member tool, in the order agents see them. */
export const MEMBER_TOOLS: readonly AnyMemberTool[] = [
  listProjects,
  getProjectStatus,
  listSessions,
  getSession,
  getDiff,
  listInbox,
  messagePm,
  messageSession,
  startSession,
  stopSession,
  answerQuestion,
  answerApproval,
  runAutomation,
  waitForSession,
];

/** A tool as listed (MCP `tools/list`, `GET /api/member-tools`). */
export interface ListedMemberTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
}

/** One call's outcome: the result, or a refusal with an HTTP status for the HTTP API. */
export type MemberToolResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500 | 502 | 503; code: string; message: string };

/**
 * The highest role a member has anywhere it can act: on an existing project, or across projects.
 * A role on a project that no longer exists counts for nothing, so tools it can never use aren't
 * listed.
 */
function highestRole(principal: Principal, projectIds: readonly string[]): MemberRole {
  const { member } = principal;
  if (member.disabled) return "none";
  return [
    memberGlobalRole(member, projectIds),
    ...projectIds.map((id) => memberRoleOn(member, id)),
  ].reduce((a, b) => (roleAtLeast(a, b) ? a : b));
}

/** Can the principal ever use this tool? Its role somewhere, and approvals for agents allowed them. */
function usable(tool: AnyMemberTool, principal: Principal, top: MemberRole): boolean {
  if (!roleAtLeast(top, tool.need)) return false;
  const { member } = principal;
  return tool.name !== answerApproval.name || member.kind !== "agent" || member.mayAnswerApprovals;
}

/**
 * The member tools (§C.2): one list for `/api/member-mcp`, the HTTP API and the CLI. Each call
 * is validated, checked with `authorize` for the tool's role on its target, then run as the
 * caller, so its events carry the member and its messages count as the member's.
 */
export class MemberToolRegistry {
  private readonly byName = new Map<string, AnyMemberTool>();

  constructor(
    private readonly services: AppServices,
    tools: readonly AnyMemberTool[] = MEMBER_TOOLS,
    private readonly log?: (message: string) => void,
  ) {
    for (const tool of tools) this.byName.set(tool.name, tool);
  }

  list(principal: Principal): ListedMemberTool[] {
    const top = highestRole(principal, authorizeContext(this.services).projectIds());
    return [...this.byName.values()]
      .filter((t) => usable(t, principal, top))
      .map((t) => {
        const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input, { io: "input" }) as Record<
          string,
          unknown
        >;
        return {
          name: t.name,
          description: t.description,
          inputSchema: { ...schema, type: "object" },
        };
      });
  }

  async call(
    name: string,
    args: unknown,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<MemberToolResult> {
    const tool = this.byName.get(name);
    const top = highestRole(principal, authorizeContext(this.services).projectIds());
    if (!tool || !roleAtLeast(top, tool.need)) {
      return { ok: false, status: 404, code: "unknown_tool", message: `Unknown tool: ${name}` };
    }
    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        status: 400,
        code: "bad_request",
        message: invalidInputMessage(name, parsed.error, args ?? {}),
      };
    }
    // Someone else's orchestrator is private (§D.1): it answers as a session that doesn't exist.
    const sessionId = (parsed.data as { sessionId?: unknown }).sessionId;
    if (
      typeof sessionId === "string" &&
      isPrivateSession(this.services.db, principal.member, sessionId)
    ) {
      return { ok: false, status: 404, code: "not_found", message: `No session ${sessionId}` };
    }
    return runAs(principal, async (): Promise<MemberToolResult> => {
      try {
        const target = tool.target(parsed.data, this.services);
        if (target) {
          const decision = authorize(principal, tool.need, target, authorizeContext(this.services));
          if (!decision.ok) {
            return {
              ok: false,
              status: decision.status,
              code: decision.code,
              message: decision.message,
            };
          }
        }
        const value = await tool.handler(parsed.data, {
          services: this.services,
          principal,
          signal,
        });
        return { ok: true, value };
      } catch (error) {
        if (error instanceof ServiceError) {
          const status =
            error.status === 413 || error.status === 415 || error.status === 422
              ? 400
              : error.status;
          return { ok: false, status, code: error.code, message: error.message };
        }
        this.log?.(`member tool ${name} failed: ${errorMessage(error)}`);
        return { ok: false, status: 500, code: "internal", message: `${name} failed` };
      }
    });
  }
}
