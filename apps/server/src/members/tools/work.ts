import { ApprovalDecision, StartSessionRequest } from "@codeden/contracts";
import { z } from "zod";
import { compactSession } from "../../mcp/tools/shared/helpers";
import { questionItem } from "../../mcp/tools/shared/session-items";
import type { AppServices } from "../../services/container";
import { badRequest, forbidden } from "../../services/errors";
import { projectOfEntity } from "../visibility";
import { defineMemberTool } from "./define";

/**
 * Member tools that act on work (§C.2, Operator). Messages from connected agents reach agents as
 * untrusted content (`members/attribution.ts`, `asSent`), whichever way they come in.
 */

const Text = z.string().trim().min(1).max(20_000);
const input = (text: string) => ({ text, attachments: [] });
const ofSession = (s: AppServices, sessionId: string) => ({
  kind: "project" as const,
  projectId: projectOfEntity(s, "session", sessionId),
});
const ofInbox = (s: AppServices, id: string) => ({
  kind: "project" as const,
  projectId: projectOfEntity(s, "inbox", id),
});

export const messageOrchestrator = defineMemberTool({
  name: "message_orchestrator",
  description:
    "Send the orchestrator (the agent that coordinates every project) a message. It is queued if the orchestrator is busy.",
  input: z.object({ text: Text }),
  need: "operator",
  target: () => ({ kind: "global" }),
  handler: async ({ text }, { services }) =>
    services.orchestration.sendToRole("orchestrator", null, input(text), "queue"),
});

export const messagePm = defineMemberTool({
  name: "message_pm",
  description: "Send a project's project manager (PM) a message. It is queued if the PM is busy.",
  input: z.object({ projectId: z.string().min(1), text: Text }),
  need: "operator",
  target: (i) => ({ kind: "project", projectId: i.projectId }),
  handler: async ({ projectId, text }, { services }) => {
    services.projects.get(projectId);
    return services.orchestration.sendToRole("pm", projectId, input(text), "queue");
  },
});

export const messageSession = defineMemberTool({
  name: "message_session",
  description:
    "Send a session's agent a message. While a turn runs it is queued, or steers the turn with steer: true when the provider can.",
  input: z.object({ sessionId: z.string().min(1), text: Text, steer: z.boolean().optional() }),
  need: "operator",
  target: (i, s) => ofSession(s, i.sessionId),
  handler: async ({ sessionId, text, steer }, { services }) =>
    services.sessions.send(sessionId, {
      input: input(text),
      whenBusy: steer ? "steer" : "queue",
    }),
});

export const startSession = defineMemberTool({
  name: "start_session",
  description:
    "Start an agent session in a project, in its own worktree, with a prompt. Optionally name the provider, model and a one-line purpose. If matching work already runs, nothing starts and the result says so (status 'conflict').",
  input: z.object({
    projectId: z.string().min(1),
    prompt: Text,
    purpose: z.string().trim().min(1).max(200).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }),
  need: "operator",
  target: (i) => ({ kind: "project", projectId: i.projectId }),
  handler: async (i, { services }) => {
    const req = StartSessionRequest.parse({
      projectId: i.projectId,
      input: input(i.prompt),
      ...(i.purpose ? { purpose: i.purpose } : {}),
      ...(i.provider ? { provider: i.provider } : {}),
      ...(i.model ? { model: i.model } : {}),
    });
    const result = await services.sessions.start(req);
    if (result.status !== "conflict") {
      services.orchestration.conflicts.closeReplaced(req, result);
      return result;
    }
    // Kept like the UI's, so a person can resolve it later (§8.4).
    const record = services.orchestration.conflicts.record(req, result.existing);
    return { ...result, conflictId: record.id };
  },
});

export const stopSession = defineMemberTool({
  name: "stop_session",
  description: "Stop a session: its running turn ends and its queued messages are dropped.",
  input: z.object({ sessionId: z.string().min(1) }),
  need: "operator",
  target: (i, s) => ofSession(s, i.sessionId),
  handler: async ({ sessionId }, { services }) =>
    compactSession(await services.sessions.stop(sessionId)),
});

export const answerQuestion = defineMemberTool({
  name: "answer_question",
  description:
    "Answer a question an agent asked (an inbox item of kind question; see get_session or list_inbox). Pass answers by question id (option labels and/or free text), or text to answer every question with it. The first answer wins: if someone answered already, you are told who.",
  input: z.object({
    inboxItemId: z.string().min(1),
    answers: z.record(z.string(), z.array(z.string().max(20_000))).optional(),
    text: Text.optional(),
  }),
  need: "operator",
  target: (i, s) => ofInbox(s, i.inboxItemId),
  handler: async ({ inboxItemId, answers, text }, { services, principal }) => {
    const item = services.inbox.get(inboxItemId);
    if (item.kind !== "question") throw badRequest("That inbox item isn't a question.");
    const asked =
      item.sessionId && item.requestId
        ? questionItem(services.db, item.sessionId, item.requestId)
        : undefined;
    // An MCP server's form asks for data for that server (keys, logins): a person's to give.
    if (asked?.mcpServer && principal.member.kind === "agent") {
      throw forbidden(`This is ${asked.mcpServer}'s form: a person answers it.`);
    }
    let given = answers;
    if (!given && text !== undefined) {
      given = Object.fromEntries((asked?.questions ?? []).map((q) => [q.id, [text]]));
    }
    if (!given || Object.keys(given).length === 0) throw badRequest("Give answers or text.");
    const resolved = await services.inbox.resolve(inboxItemId, {
      status: "resolved",
      response: { kind: "answer", answers: given },
    });
    return { id: resolved.id, status: resolved.status };
  },
});

export const answerApproval = defineMemberTool({
  name: "answer_approval",
  description:
    "Approve or deny an action an agent waits on (an inbox item of kind approval): allow_once, allow_session or deny. Connected agents may do this only when an owner allowed it (May answer approvals). The first answer wins.",
  input: z.object({ inboxItemId: z.string().min(1), decision: ApprovalDecision }),
  need: "operator",
  target: (i, s) => ofInbox(s, i.inboxItemId),
  handler: async ({ inboxItemId, decision }, { services }) => {
    const item = services.inbox.get(inboxItemId);
    if (item.kind !== "approval") throw badRequest("That inbox item isn't an approval.");
    const resolved = await services.inbox.resolve(inboxItemId, {
      status: "resolved",
      response: { kind: "approval", decision },
    });
    return { id: resolved.id, status: resolved.status };
  },
});

export const runAutomation = defineMemberTool({
  name: "run_automation",
  description:
    "Run an automation now in a project. It runs at the automation's own permission level. If matching work already runs, the result says so (status 'conflict').",
  input: z.object({ automationId: z.string().min(1), projectId: z.string().min(1) }),
  need: "operator",
  target: (i) => ({ kind: "project", projectId: i.projectId }),
  handler: async ({ automationId, projectId }, { services, principal }) =>
    services.automations.run(
      automationId,
      { projectId },
      { byPerson: principal.member.kind === "person" },
    ),
});
