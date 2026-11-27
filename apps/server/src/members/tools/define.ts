import type { MemberRole } from "@codeden/contracts";
import type { z } from "zod";
import type { AppServices } from "../../services/container";
import type { AuthTarget } from "../authorize";
import type { Principal } from "../principal";

/** What a member tool's handler gets: the services the UI's API uses, and who is calling. */
export interface MemberToolContext {
  services: AppServices;
  principal: Principal;
  signal: AbortSignal;
}

/**
 * A member-level tool (§C.2): a thin wrapper over the service the UI's API calls, offered to
 * connected agents over `/api/member-mcp`, the HTTP API (`/api/member-tools/<name>`) and the
 * `codeden` CLI. Every call is checked with `authorize` for `need` on `target`.
 */
export interface MemberTool<TInput extends z.ZodType = z.ZodType> {
  /** snake_case. */
  name: string;
  /** Shown to the agent; written for a model. */
  description: string;
  input: TInput;
  /** The least role it needs. */
  need: MemberRole;
  /**
   * What the call is about, for the role check: a project, work across projects, or `null` when
   * the tool lists things and keeps only what the member can see.
   */
  target: (input: z.output<TInput>, services: AppServices) => AuthTarget | null;
  handler: (input: z.output<TInput>, ctx: MemberToolContext) => Promise<unknown>;
}

export function defineMemberTool<TInput extends z.ZodType>(
  tool: MemberTool<TInput>,
): MemberTool<TInput> {
  return tool;
}

// biome-ignore lint/suspicious/noExplicitAny: registries hold heterogeneous tools.
export type AnyMemberTool = MemberTool<any>;
