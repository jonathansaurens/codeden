import type { MemberRole } from "@codeden/contracts";

/**
 * Who may call each HTTP route (§B.3), in one table so nothing is decided route by route.
 * Every route `createApi` registers must be listed (`test/route-rules.test.ts` walks them), and a
 * route missing here is refused to everyone but owners, so a new route can't slip through.
 *
 * - `need`: `public` (no sign-in), `member` (anyone signed in; the answer may be `filter`ed to the
 *   projects they can see), or the least role required.
 * - `scope`: what the role is checked on. A path, body or query parameter names a project, or an
 *   entity whose project is looked up (`members/route-gate.ts`). `server` is the server-wide
 *   role, `global` the lowest role anywhere (work across projects).
 */
export type Need = "public" | "member" | MemberRole;

export type EntityKind =
  | "project"
  | "session"
  | "inbox"
  | "automation"
  | "run"
  | "pr"
  | "conflict"
  | "artifact";

export type Scope =
  | "server"
  | "global"
  /** The member's own orchestrator: the highest role they have anywhere. */
  | "own"
  /** A path parameter naming an entity. */
  | { param: string; entity: EntityKind }
  /** A JSON body field naming a project or session. */
  | { body: "projectId" | "sessionId" }
  /** Query parameters naming a session or project; without them, work across projects. */
  | { query: readonly ("projectId" | "sessionId")[] };

/** Answers cut down to what a member with hidden projects may see. */
export type ResponseFilter =
  | "snapshot"
  | "projects"
  | "sessions"
  | "inbox"
  | "inboxCounts"
  | "search";

export interface RouteRule {
  need: Need;
  scope?: Scope;
  filter?: ResponseFilter;
}

const pub: RouteRule = { need: "public" };
const member = (filter?: ResponseFilter): RouteRule => ({ need: "member", filter });
const rule = (need: MemberRole, scope: Scope): RouteRule => ({ need, scope });
const v = (scope: Scope) => rule("viewer", scope);
const o = (scope: Scope) => rule("operator", scope);
const w = (scope: Scope) => rule("owner", scope);

const project = (param = "id"): Scope => ({ param, entity: "project" });
const session = (param = "id"): Scope => ({ param, entity: "session" });
const inbox = (param = "id"): Scope => ({ param, entity: "inbox" });
const automation: Scope = { param: "id", entity: "automation" };
const run: Scope = { param: "runId", entity: "run" };
const pr: Scope = { param: "id", entity: "pr" };
const conflict: Scope = { param: "id", entity: "conflict" };
const artifact: Scope = { param: "id", entity: "artifact" };

export const ROUTE_RULES: Readonly<Record<string, RouteRule>> = {
  "GET /health": pub,
  "GET /snapshot": member("snapshot"),
  "GET /activity": v("global"),
  "GET /sessions/:id/snapshot": v(session()),

  // Projects
  "GET /projects": member("projects"),
  "POST /projects": w("server"),
  "PUT /projects/order": w("server"),
  "GET /projects/:id": v(project()),
  "PATCH /projects/:id": w(project()),
  "GET /projects/:id/commands": v(project()),
  "GET /projects/:id/sessions/archived": v(project()),
  "GET /projects/:id/files": v(project()),
  "GET /projects/:id/checks": v(project()),
  "POST /projects/:id/refresh": o(project()),
  "POST /projects/:id/disconnect-github": w(project()),
  "DELETE /projects/:id": w(project()),
  "GET /execution/backends": v("server"),
  // Machines (Part A): anyone who can see work may list them (New session picks one);
  // changing them is server administration.
  "GET /machines": v("global"),
  "POST /machines": w("server"),
  "PUT /machines/home/weight": w("server"),
  "PATCH /machines/:id": w("server"),
  "POST /machines/:id/reconnect": w("server"),
  // Your own computer (§D.5): any person; disconnecting is its person's or an Owner's (checked
  // by the service).
  "POST /machines/connect-codes": member(),
  "GET /machines/connect-codes/:id": member(),
  "POST /machines/:id/disconnect": member(),
  "DELETE /machines/:id": w("server"),

  // GitHub
  "GET /projects/:id/github/issues": v(project()),
  "GET /projects/:id/github/prs": v(project()),
  "POST /projects/:id/github/sync": o(project()),
  "POST /projects/:id/github/issues": o(project()),
  "GET /projects/:id/github/issues/:number": v(project()),
  "POST /projects/:id/github/issues/:number/comments": o(project()),
  "POST /projects/:id/github/issues/:number/labels": o(project()),
  "POST /projects/:id/github/issues/:number/triage": o(project()),
  "GET /prs/:id": v(pr),
  "GET /prs/:id/diff": v(pr),
  "POST /prs/:id/merge": o(pr),
  "GET /github/connection": v("server"),
  "GET /sessions/:id/github": v(session()),

  // Factory
  "GET /projects/:id/factory": v(project()),
  "PUT /projects/:id/autonomy": w(project()),
  "GET /projects/:id/vision": v(project()),
  "PUT /projects/:id/vision": w(project()),
  "POST /projects/:id/kill-switch": o(project()),
  "POST /projects/:id/factory/resume": o(project()),
  "POST /projects/:id/factory/tick": o(project()),
  "POST /projects/:id/factory/scout": o(project()),
  "POST /projects/:id/factory/digest": o(project()),
  "GET /projects/:id/factory/scorecard": v(project()),
  "GET /projects/:id/factory/items/:itemId": v(project()),
  "POST /projects/:id/factory/admit": o(project()),
  "POST /projects/:id/factory/set-type": o(project()),
  "POST /projects/:id/factory/items/:itemId/retry": o(project()),
  "POST /projects/:id/factory/items/:itemId/dismiss": o(project()),
  "POST /projects/:id/factory/items/:itemId/spec": o(project()),
  "POST /projects/:id/factory/items/:itemId/spot-check": o(project()),
  "POST /projects/:id/factory/items/:itemId/spot-check/file-issue": o(project()),
  "DELETE /projects/:id/factory/lessons/:lessonId": w(project()),
  "POST /projects/:id/factory/items/:itemId/follow-ups/file": o(project()),
  "POST /projects/:id/factory/items/:itemId/follow-ups/dismiss": o(project()),
  "POST /factory/kill-switch": o("global"),

  // Sessions
  "GET /sessions": member("sessions"),
  "POST /sessions": o({ body: "projectId" }),
  "GET /sessions/:id": v(session()),
  "PATCH /sessions/:id": o(session()),
  "POST /sessions/:id/messages": o(session()),
  "POST /sessions/:id/steer": o(session()),
  "POST /sessions/:id/interrupt": o(session()),
  "POST /sessions/:id/compact": o(session()),
  "POST /sessions/:id/respond": o(session()),
  "POST /sessions/:id/stop": o(session()),
  "POST /sessions/:id/fork": o(session()),
  "POST /sessions/:id/handoff": o(session()),
  "POST /sessions/:id/review": o(session()),
  "GET /sessions/:id/export": v(session()),
  "POST /sessions/:id/archive": o(session()),
  "POST /sessions/:id/unarchive": o(session()),
  "GET /sessions/:id/queue": v(session()),
  "PATCH /sessions/:id/queue/:messageId": o(session()),
  "DELETE /sessions/:id/queue/:messageId": o(session()),
  "POST /sessions/:id/queue/:messageId/send-now": o(session()),
  "GET /sessions/:id/threads/:threadId/items": v(session()),
  "GET /sessions/:id/items/:itemId/output": v(session()),
  "GET /sessions/:id/checkpoints": v(session()),
  // A read: the diff's scope travels in the body.
  "POST /sessions/:id/diff": v(session()),
  "POST /sessions/:id/restore": o(session()),
  "GET /sessions/:id/git/status": v(session()),
  "POST /sessions/:id/git/commit": o(session()),
  "POST /sessions/:id/git/push": o(session()),
  "GET /sessions/:id/agent-config/loaded": v(session()),
  "GET /sessions/:id/commands": v(session()),
  "GET /sessions/:id/files": v(session()),
  "GET /sessions/:id/files/content": v(session()),

  // The session browser
  "POST /sessions/:id/browser/open": o(session()),
  "POST /sessions/:id/browser/close": o(session()),
  "GET /sessions/:id/browser/tabs": v(session()),
  "POST /sessions/:id/browser/tabs": o(session()),
  "DELETE /sessions/:id/browser/tabs/:tabId": o(session()),
  "POST /sessions/:id/browser/tabs/:tabId/activate": o(session()),
  "POST /sessions/:id/browser/navigate": o(session()),
  "POST /sessions/:id/browser/history": o(session()),
  "POST /sessions/:id/browser/viewport": o(session()),
  "POST /sessions/:id/browser/dev-server": o(session()),
  "GET /browser/dev-servers": v("global"),

  // Images, voice, read-aloud
  "GET /images/engines": member(),
  "POST /images/test": w("server"),
  "GET /voice/voices": member(),
  "GET /voice/local": member(),
  "POST /voice/local/models/:id/download": w("server"),
  "DELETE /voice/local/models/:id": w("server"),
  "POST /tts": member(),
  "POST /stt": member(),
  "POST /utility/speech-summary": member(),

  // Agent configuration: the user's own provider files (MCP servers can hold keys).
  "GET /agent-config/files": w("server"),
  "GET /agent-config/file": w("server"),
  "PUT /agent-config/file": w("server"),
  "POST /agent-config/file": w("server"),
  "DELETE /agent-config/file": w("server"),
  "POST /agent-config/diff": w("server"),
  "GET /agent-config/mcp": w("server"),
  "PUT /agent-config/mcp": w("server"),
  "DELETE /agent-config/mcp": w("server"),
  "POST /agent-config/mcp/diff": w("server"),
  "POST /agent-config/mcp/test": w("server"),
  "GET /agent-config/hooks": w("server"),
  "POST /agent-config/hooks/diff": w("server"),
  "POST /agent-config/hooks": w("server"),
  "GET /agent-config/skills": w("server"),
  "POST /agent-config/skills/diff": w("server"),
  "POST /agent-config/skills": w("server"),

  // Inbox
  "GET /inbox": member("inbox"),
  "GET /inbox/counts": member("inboxCounts"),
  "POST /inbox/dismiss": o("global"),
  "POST /inbox/restore": o("global"),
  "GET /inbox/:id": v(inbox()),
  "POST /inbox/:id/resolve": o(inbox()),
  "POST /inbox/:id/retry": o(inbox()),

  // Orchestrator and PMs
  // Each person's own orchestrator (§D.1): it shows them only the projects they can see.
  "GET /orchestration/orchestrator": v("own"),
  "POST /orchestration/orchestrator": o("own"),
  "POST /orchestration/orchestrator/messages": o("own"),
  "POST /orchestration/orchestrator/start-fresh": o("own"),
  "GET /orchestration/orchestrator/runs-on": v("own"),
  "PUT /orchestration/orchestrator/runs-on": o("own"),
  "GET /orchestration/projects/:projectId/pm": v(project("projectId")),
  "POST /orchestration/projects/:projectId/pm": o(project("projectId")),
  "POST /orchestration/projects/:projectId/pm/messages": o(project("projectId")),
  "POST /orchestration/projects/:projectId/pm/start-fresh": o(project("projectId")),
  "GET /orchestration/projects/:projectId/status": v(project("projectId")),
  "GET /orchestration/overview": v("global"),
  "GET /orchestration/roles": v("global"),
  "GET /orchestration/notices": v("global"),
  "GET /conflicts": v("global"),
  "GET /conflicts/:id": v(conflict),
  "POST /conflicts/:id/resolve": o(conflict),

  // Automations: running one is work, defining one is administration (§B.3).
  "GET /automations": v("global"),
  "POST /automations": w("server"),
  "GET /automations/templates": v("server"),
  "GET /automations/export": v("global"),
  "POST /automations/import/preview": w("server"),
  "POST /automations/import/link": w("server"),
  "POST /automations/import": w("server"),
  "GET /automations/upcoming": v("global"),
  "GET /automations/runs": v("global"),
  "GET /automations/runs/:runId": v(run),
  "POST /automations/runs/:runId/cancel": o(run),
  "POST /automations/reload": w("server"),
  "POST /automations/triage/:itemId/accept": o(inbox("itemId")),
  "POST /automations/triage/:itemId/decline": o(inbox("itemId")),
  "GET /automations/:id": v(automation),
  "PATCH /automations/:id": w(automation),
  "GET /automations/:id/export": v(automation),
  "POST /automations/:id/duplicate": w(automation),
  "DELETE /automations/:id": w(automation),
  "POST /automations/:id/enable": w(automation),
  "POST /automations/:id/disable": w(automation),
  "POST /automations/:id/clear-override": w(automation),
  // An automation for every project runs in the one the request names.
  "POST /automations/:id/run": o({ body: "projectId" }),
  "POST /automations/:id/pause": w(automation),
  "POST /automations/:id/resume": w(automation),
  "POST /automations/:id/skip-next": w(automation),
  "POST /automations/:id/unskip-next": w(automation),
  "POST /projects/:projectId/automations/starter": w(project("projectId")),
  "GET /projects/:projectId/automations/settings": v(project("projectId")),
  "PATCH /projects/:projectId/automations/settings": w(project("projectId")),

  // Usage and search
  "GET /usage/report": v("global"),
  "GET /usage/export.csv": v("global"),
  "GET /usage/sessions/:id": v(session()),
  "GET /usage/projects/:id": v(project()),
  "GET /usage/limits": v("global"),
  "GET /usage/budgets": v("global"),
  "GET /usage/settings": v("global"),
  "PUT /usage/settings": w("server"),
  "GET /search/transcripts": member("search"),

  // Setup, providers, updates
  "GET /setup/status": v("server"),
  "POST /setup/login/:tool": w("server"),
  "GET /setup/claude-sdk": v("server"),
  "POST /setup/claude-sdk/install": w("server"),
  "POST /setup/complete": w("server"),
  "POST /providers/:id/refresh-models": o("server"),
  "GET /providers/:id/models": member(),
  "GET /providers/:id/history": w("server"),
  "POST /providers/:id/history/hide": w("server"),
  "GET /updates": member(),
  "POST /updates/install": w("server"),
  "POST /updates/restart": w("server"),
  "POST /updates/rollback": w("server"),
  "GET /updates/notes": member(),

  // Files and images
  "GET /artifacts": v({ query: ["sessionId", "projectId"] }),
  "GET /artifacts/:id/meta": v(artifact),
  "GET /artifacts/:id": v(artifact),
  "POST /remote-image": member(),
  "GET /remote-image/:id": member(),
  "GET /fs/list": w("server"),
  "GET /files": w("server"),
  "PUT /files": w("server"),

  // Secrets, network access, settings, the server
  "GET /secrets": w("server"),
  "PUT /secrets/:key": w("server"),
  "DELETE /secrets/:key": w("server"),
  "GET /network": w("server"),
  "PUT /network": w("server"),
  "POST /network/origins": w("server"),
  "DELETE /network/origins": w("server"),
  "POST /network/password": w("server"),
  "DELETE /network/devices/:id": w("server"),
  "DELETE /network/devices": w("server"),
  "GET /settings": member(),
  "PATCH /settings": w("server"),
  "POST /shutdown": w("server"),

  // Sign-in (public: the security middleware lets these through without a session)
  "GET /auth/status": pub,
  "POST /auth/sign-in": pub,
  "POST /auth/invite": pub,
  "POST /auth/join": pub,
  "POST /auth/sign-out": pub,

  // Members
  "GET /members/me": member(),
  "GET /members/summaries": member(),
  "GET /members": w("server"),
  "GET /members/activity": w("server"),
  "POST /members/invites": w("server"),
  "DELETE /members/invites/:inviteId": w("server"),
  "PATCH /members/:id": w("server"),
  "DELETE /members/:id": w("server"),
  "DELETE /members/:id/devices/:deviceId": w("server"),
  "POST /members/agents": w("server"),

  // Connected agents' interfaces (§C.2): each tool checks the member's role on its target.
  "POST /member-mcp": member(),
  "GET /member-mcp": member(),
  "DELETE /member-mcp": member(),
  "GET /member-tools": member(),
  "POST /member-tools/:name": member(),
  "POST /members/:id/tokens": w("server"),
  "DELETE /members/:id/tokens/:tokenId": w("server"),
};
