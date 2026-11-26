import { randomUUID } from "node:crypto";
import {
  type ConflictRecord,
  type InboxItem,
  isActiveSession,
  messageFrom,
  type Notice,
  type Overview,
  type ProjectStatus,
  type QueueSender,
  type RawEventEnvelope,
  type RoleMessageResponse,
  type Session,
  type UserInput,
} from "@codeden/contracts";
import type { Db } from "../../db/client";
import type { EventStore } from "../../events/store";
import {
  type ActingFor,
  actingCanSee,
  actingRole,
  type MemberLookup,
  membersOf,
} from "../../members/acting";
import type { SettingsStore } from "../../settings-store";
import type { ArtifactService } from "../artifacts";
import { isValidTimezone, machineTimezone } from "../automations/cron";
import { errorMessage } from "../errors";
import type { TrustedAuthors } from "../github/review-trust";
import type { InboxService } from "../inbox-service";
import type { ProjectService } from "../projects/project-service";
import type { RunnerPort } from "../runner-port";
import { inArchivedProject } from "../sessions/archived-project";
import { mayHaveStarted } from "../sessions/input-decorator";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import { type AskOutcome, askMarker, finalAssistantMessage, PmAsks } from "./asks";
import { NoticeCards } from "./cards";
import { ConflictService } from "./conflicts";
import { NoticeDelivery } from "./delivery";
import {
  buildProjectStatus,
  dayAgo,
  renderOverviewDigest,
  renderProjectDigest,
  sharedWork,
} from "./digest";
import { deriveGithubNotices, GITHUB_NOTICE_EVENTS } from "./github-notices";
import { type HeldMessage, LoopGuard, type MessageOrigin, turnOriginsIn } from "./loop-guard";
import { ProjectNotes } from "./notes";
import {
  deriveNotices,
  formServerOf,
  isRepeatFailure,
  type NoticeDraft,
  NoticeStore,
} from "./notices";
import {
  type AutomationPort,
  type GithubPort,
  UnavailableAutomationPort,
  UnavailableGithubPort,
} from "./ports";
import { Reminders } from "./reminders";
import { memberOfKey, parseWakeKey, personKey, wakeKey } from "./role-keys";
import { RoleLimitSwitch } from "./role-limit-switch";
import { type OrchestrationRole, RoleSessions } from "./role-sessions";
import { TurnAuthority } from "./turn-authority";
import { type WakeResult, WakeScheduler, type WakeSchedulerOptions } from "./wake-scheduler";

export interface OrchestrationOptions {
  wake?: WakeSchedulerOptions;
  /** Default `ask_pm` wait (3 minutes). */
  askTimeoutMs?: number;
  /** Waits before waking a role session again after a failed turn (`NoticeDelivery`). */
  failedTurnRetryMs?: number[];
  /** Shortest `schedule_wakeup` wait (default 1 minute). */
  wakeupMinDelayMs?: number;
}

export interface OrchestrationDeps {
  db: Db;
  store: EventStore;
  repo: SessionRepo;
  sessions: SessionService;
  projects: ProjectService;
  inbox: InboxService;
  settings: Pick<SettingsStore, "get">;
  /** The home runner, whose providers the orchestrator and the PMs can run on. */
  runner: Pick<RunnerPort, "isConnected" | "providers">;
  /** Saves the pasted images of a conflicting start before it is recorded. */
  artifacts: Pick<ArtifactService, "externalizeAttachments">;
  github?: GithubPort;
  /** Members, for whom role turns act (§D.2). */
  members: MemberLookup;
  /** The project's trusted authors, whose PR reviews count without write access. Default: none. */
  trustedAuthors?: TrustedAuthors;
  automation?: AutomationPort;
  /** The user's IANA timezone (the usage settings', else the machine's). Default: the machine's. */
  timezone?: () => string;
  /** Ids of the providers ready for new work (installed, signed in), for a role's fallback. */
  readyProviders?: () => Promise<string[]>;
  /** The factory loop of a project, for the status digest (null outside the factory modes). */
  factoryLoop?: (projectId: string) => ProjectStatus["factory"];
  options?: OrchestrationOptions;
  log?: (message: string) => void;
}

const WAKE_TEXT =
  "Automatic wake-up for the updates above. Act on anything that needs it; otherwise reply in one short line.";

/**
 * Orchestration (§8): the orchestrator and PM sessions, the status digest injected on every
 * wake, typed notices batched into debounced wakes with a loop guard, PM <-> orchestrator
 * messaging (`ask_pm` waits for the answer), persisted conflicts and project notes.
 */
export class OrchestrationService {
  readonly roles: RoleSessions;
  readonly notices: NoticeStore;
  readonly conflicts: ConflictService;
  readonly notes: ProjectNotes;
  readonly asks: PmAsks;
  readonly github: GithubPort;
  readonly automation: AutomationPort;
  readonly wakes: WakeScheduler;
  readonly loops: LoopGuard;
  readonly reminders: Reminders;
  /** Who each role session's turn acts for (§D.2): its tools act with their role. */
  readonly authority: TurnAuthority;
  private readonly cards: NoticeCards;
  private readonly delivery: NoticeDelivery;
  /** Moves a role to another provider when its own hits its usage limit (§8.1). */
  private readonly limits: RoleLimitSwitch;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: OrchestrationDeps) {
    this.roles = new RoleSessions({
      ...deps,
      // An `ask_pm` whose question moved with the queue gets its answer from the new session.
      onMoved: (from, to, why) => {
        this.asks.retarget(from.id, to.id);
        this.limits.moved(from, to, why);
      },
    });
    this.limits = new RoleLimitSwitch({
      ...deps,
      roles: this.roles,
      ready: deps.readyProviders,
      timezone: () => this.timezone(),
    });
    this.notices = new NoticeStore(deps.db, deps.store);
    this.authority = new TurnAuthority(deps.repo);
    this.cards = new NoticeCards(deps.store);
    this.notes = new ProjectNotes(deps.projects);
    this.github = deps.github ?? new UnavailableGithubPort();
    this.automation = deps.automation ?? new UnavailableAutomationPort();
    this.conflicts = new ConflictService({
      ...deps,
      onRecorded: (record) => this.onConflict(record),
    });
    this.asks = new PmAsks({
      db: deps.db,
      session: (id) => deps.repo.find(id)?.session,
      // The answer goes back to the orchestrator that asked (§D.3).
      onLateReply: (reply) =>
        this.postToOrchestrator(
          reply.projectId,
          reply.pmSessionId,
          `Answer to your earlier ask_pm question:\n${reply.text}`,
          false,
          `pm.message:ask:${reply.askId}`,
          reply.askedFor ? [reply.askedFor] : undefined,
        ),
    });
    this.wakes = new WakeScheduler((key) => this.fire(key), {
      ...deps.options?.wake,
      onSuppressed: (key, until) =>
        deps.log?.(
          `orchestration: loop guard holds wakes for ${key} until ${new Date(until).toISOString()}`,
        ),
      onGaveUp: (key) =>
        deps.log?.(
          `orchestration: ${key} stayed busy; its notices wait for its next message or notice`,
        ),
    });
    this.loops = new LoopGuard({
      wakes: this.wakes,
      notices: this.notices,
      wakePm: (projectId) => this.fire(wakeKey("pm", projectId)),
      turnOrigins: turnOriginsIn(deps.repo),
      options: deps.options?.wake,
      log: deps.log,
    });
    this.delivery = new NoticeDelivery({
      db: deps.db,
      notices: this.notices,
      cards: this.cards,
      wakes: this.wakes,
      digestFor: (session) => this.digestFor(session),
      projectName: (id) => this.projectName(id),
      session: (id) => deps.repo.find(id)?.session,
      projectIds: () => deps.projects.list().flatMap((p) => (p.archivedAt ? [] : [p.id])),
      retryDelaysMs: deps.options?.failedTurnRetryMs,
      log: deps.log,
    });
    const minDelayMs = deps.options?.wakeupMinDelayMs;
    this.reminders = new Reminders({ notices: this.notices, wakes: this.wakes, minDelayMs });
  }

  start(): void {
    this.unsubscribe = this.deps.store.subscribe((events) => this.onEvents(events));
    this.deps.sessions.setInputDecorator((session, input, from) => {
      // Who the turn is from counts once the runner takes it (the loop guard, #137).
      const turn = this.loops.beginTurn(session, from, input);
      // Who the turn acts for (§D.2), before the digest, which shows only their projects.
      const people = this.authority.begin(session, input, from);
      this.limits.sending(session, input, from);
      try {
        // The status digest and undelivered notices, fresh at send time (§8.4, `NoticeDelivery`).
        const decorated = this.delivery.decorate(session, input);
        people.carry(decorated.notices ?? []);
        return {
          input: decorated.input,
          delivered: () => {
            decorated.delivered?.();
            turn.accepted();
          },
          failed: (error) => {
            decorated.failed?.(error);
            turn.failed(mayHaveStarted(error));
            people.failed(mayHaveStarted(error));
          },
        };
      } catch (error) {
        // Nothing was sent.
        turn.failed(false);
        people.failed(false);
        throw error;
      }
    });
    this.deps.sessions.setSteerObserver((session, input) =>
      this.authority.steered(session, input, input.from ?? "user"),
    );
    this.delivery.rearm();
    this.reminders.start();
  }

  stop(): void {
    this.unsubscribe?.();
    this.wakes.dispose();
    this.loops.dispose();
    this.delivery.dispose();
    this.reminders.dispose();
  }

  // ---------------------------------------------------------------- authority

  /**
   * Who a role session's current turn acts for (§D.2): an orchestrator always its person; a
   * PM the people whose messages are in the turn, or, when only automatic events started it,
   * CodeDen itself (`null`, an Owner of the project).
   */
  actingFor(session: Session): ActingFor {
    if (session.role === "agent") return null;
    // An orchestrator is its person's alone (§D.1): only they write to it.
    if (session.role === "orchestrator") {
      return membersOf(this.members(), [memberOfKey(personKey(session.ownerMemberId))]);
    }
    const { members } = this.authority.of(session.id);
    return members.length > 0 ? membersOf(this.members(), members) : null;
  }

  /** May the people a role session's turn acts for see this project? */
  visibleTo(session: Session): (projectId: string) => boolean {
    const people = this.actingFor(session);
    if (people === null) return () => true;
    const ctx = { projectIds: () => this.deps.projects.list().map((p) => p.id) };
    return (projectId) => actingCanSee(people, projectId, ctx);
  }

  private members(): MemberLookup {
    return this.deps.members;
  }

  /**
   * The people (person keys) whose orchestrators hear a project's news that no orchestrator
   * asked for (§D.3): its Owners. Connected agents have no orchestrator.
   */
  private ownersOf(projectId: string | null): (string | null)[] {
    const target = { kind: "project" as const, projectId };
    const ctx = { projectIds: () => this.deps.projects.list().map((p) => p.id) };
    const owners = this.members()
      .list()
      .filter((m) => m.kind === "person" && actingRole([m], target, ctx) === "owner");
    return [...new Set(owners.map((m) => personKey(m.id)))];
  }

  // ---------------------------------------------------------------- digest

  projectStatus(projectId: string): ProjectStatus {
    const project = this.deps.projects.get(projectId);
    const roleIds = this.roles.roleSessionIds();
    return buildProjectStatus({
      project,
      work: this.deps.repo
        .activeWork(projectId)
        .filter((w) => !(w.sessionId && roleIds.has(w.sessionId))),
      scheduled: this.automation.listScheduledRuns(projectId, 5),
      inbox: this.deps.inbox.list({ projectId }),
      outcomes: this.notices.recent(projectId, ["session.finished", "session.failed"], dayAgo()),
      factory: this.deps.factoryLoop?.(projectId) ?? null,
    });
  }

  /**
   * Every project rolled up, for a person's orchestrator (`person`, a member id; default the
   * first owner): `visible` leaves out the projects they can't see (§D.1).
   */
  overview(
    visible: (projectId: string) => boolean = () => true,
    person: string | null = null,
  ): Overview {
    const projects = this.deps.projects
      .list()
      .filter((p) => visible(p.id))
      .map((p) => this.projectStatus(p.id));
    const pmMessages = this.notices
      .undelivered("orchestrator", null, personKey(person))
      .flatMap((n) =>
        n.type === "pm.message" && n.data.informational && (!n.projectId || visible(n.projectId))
          ? [{ projectId: n.projectId, text: n.data.text, at: n.createdAt }]
          : [],
      );
    return {
      generatedAt: new Date().toISOString(),
      projects,
      sharedWork: sharedWork(projects),
      pmMessages,
    };
  }

  /** The user's IANA timezone, for the clock times the PM and the orchestrator tell the user. */
  timezone(): string {
    const tz = this.deps.timezone?.();
    return tz && isValidTimezone(tz) ? tz : machineTimezone();
  }

  /** The digest text for a role session's next turn. */
  digestFor(session: Session): string {
    if (session.role === "pm" && session.projectId) {
      return renderProjectDigest(
        this.projectStatus(session.projectId),
        Date.now(),
        this.timezone(),
      );
    }
    return renderOverviewDigest(
      { ...this.overview(this.visibleTo(session), session.ownerMemberId ?? null), pmMessages: [] },
      Date.now(),
      this.timezone(),
    );
  }

  // ---------------------------------------------------------------- messaging

  /**
   * Send a message to a person's orchestrator or a project's PM, creating the session if
   * needed. `of` is the PM's project, or the orchestrator's person (a member id; null: the first
   * owner). `from` labels the message in the queue tray when it has to wait for a running turn.
   */
  async sendToRole(
    role: OrchestrationRole,
    of: string | null,
    input: UserInput,
    whenBusy: "queue" | "steer" | "reject" = "queue",
    from: QueueSender = "user",
  ): Promise<RoleMessageResponse> {
    const session = await this.roles.ensure(role, of);
    const res = await this.deps.sessions.send(session.id, { input, whenBusy }, from);
    return { sessionId: session.id, status: res.status };
  }

  /**
   * `message_pm`: hand a PM a task without waiting. Past the loop guard's limit (§8.2) the
   * message is held and delivered automatically; the user's own requests are never held.
   */
  async messagePm(
    projectId: string,
    text: string,
    origin: MessageOrigin,
  ): Promise<RoleMessageResponse | HeldMessage> {
    await this.roles.ensure("pm", projectId);
    const forUser = this.loops.humanLed(origin);
    if (!this.loops.mayDeliver(projectId, origin)) {
      const until = this.loops.hold(projectId, origin.sessionId, text, origin.onBehalfOf);
      return { status: "held", until };
    }
    return this.sendToRole(
      "pm",
      projectId,
      relayed(messageFrom("orchestrator", text), forUser, origin.onBehalfOf),
      "queue",
      "orchestrator",
    );
  }

  /**
   * `ask_pm`: ask a PM and wait (up to `timeoutMs`) for the answer. A question the loop guard
   * holds back (§8.2) is answered later, as a message to the orchestrator.
   */
  async askPm(
    projectId: string,
    question: string,
    opts: { origin: MessageOrigin; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<(AskOutcome & { pmSessionId: string }) | HeldMessage> {
    const pm = await this.roles.ensure("pm", projectId);
    const forUser = this.loops.humanLed(opts.origin);
    const askId = randomUUID().slice(0, 8);
    const target = { pmSessionId: pm.id, projectId, fromSessionId: opts.origin.sessionId };
    const text = [
      `Question from the orchestrator ${askMarker(askId)}:`,
      question,
      "",
      "Answer in your final message of this turn: it is returned to the orchestrator directly.",
    ].join("\n");
    const { onBehalfOf } = opts.origin;
    if (!this.loops.mayDeliver(projectId, opts.origin)) {
      this.asks.register(askId, target, { detached: true });
      const until = this.loops.hold(projectId, opts.origin.sessionId, text, onBehalfOf);
      return { status: "held", until };
    }
    this.asks.register(askId, target);
    const answer = this.asks.wait(
      askId,
      opts.timeoutMs ?? this.deps.options?.askTimeoutMs ?? 180_000,
      opts.signal,
    );
    await this.deps.sessions.send(
      pm.id,
      {
        input: relayed({ text, attachments: [], from: "orchestrator" }, forUser, onBehalfOf),
        whenBusy: "queue",
      },
      "orchestrator",
    );
    return { ...(await answer), pmSessionId: pm.id };
  }

  /** `message_orchestrator`: a PM reports; informational messages never wake the orchestrator. */
  messageOrchestrator(
    pm: Session,
    text: string,
    opts: { informational: boolean; replyTo?: string },
  ): "answered" | "queued" | "noted" {
    if (opts.replyTo && this.asks.answer(opts.replyTo, text)) return "answered";
    // A report in a turn orchestrators' messages started goes back to them (§D.3).
    const asked = this.authority.of(pm.id).orchestrators;
    this.postToOrchestrator(
      pm.projectId,
      pm.id,
      text,
      opts.informational,
      undefined,
      asked.length > 0 ? asked : undefined,
    );
    return opts.informational ? "noted" : "queued";
  }

  /**
   * Record a notice (other services: GitHub checks, automations); wakes its target when asked.
   * A notice for the orchestrator goes to the person its `memberId` names; without one, to the
   * orchestrator of every Owner of its project (§D.3), each its own copy (the first owner's
   * keeps the notice's id). Returns the first owner's copy, or the first one made.
   */
  notify(draft: NoticeDraft, wake = true): Notice | undefined {
    if (draft.target !== "orchestrator") return this.record(draft, wake);
    const people =
      draft.memberId !== undefined ? [personKey(draft.memberId)] : this.ownersOf(draft.projectId);
    let first: Notice | undefined;
    for (const person of people) {
      const { memberId: _given, ...rest } = draft;
      const copy = (
        person ? { ...rest, id: `${draft.id}:${person}`, memberId: person } : rest
      ) as NoticeDraft;
      const created = this.record(copy, wake);
      if (!first || !person) first = created ?? first;
    }
    return first;
  }

  private record(draft: NoticeDraft, wake: boolean): Notice | undefined {
    const created = this.notices.create({ ...draft, wake });
    if (created && wake) {
      this.wakes.request(wakeKey(created.target, created.projectId, created.memberId));
    }
    return created;
  }

  // ---------------------------------------------------------------- internals

  /**
   * A PM's message to the orchestrators of `people` (member ids), or of the project's Owners
   * when no orchestrator asked for it (§D.3).
   */
  private postToOrchestrator(
    projectId: string | null,
    fromSessionId: string,
    text: string,
    informational: boolean,
    id = `pm.message:${randomUUID()}`,
    people?: readonly string[],
  ): void {
    const name = projectId ? this.projectName(projectId) : "a project";
    const draft: NoticeDraft = {
      id,
      type: "pm.message",
      projectId,
      target: "orchestrator",
      sessionId: fromSessionId,
      title: `${informational ? "Update" : "Message"} from the PM of ${name}`,
      data: { fromSessionId, text, informational },
    };
    if (!people) {
      this.notify(draft, !informational);
      return;
    }
    for (const memberId of new Set(people.map((m) => memberOfKey(personKey(m))))) {
      this.notify({ ...draft, memberId }, !informational);
    }
  }

  private onConflict(record: ConflictRecord): void {
    if (!record.projectId) return;
    this.notify({
      id: `conflict:${record.id}`,
      type: "conflict",
      projectId: record.projectId,
      target: "pm",
      sessionId: record.existing[0]?.sessionId ?? null,
      title: `Conflict: ${record.request.purpose}`,
      data: {
        conflictId: record.id,
        workKey: record.request.workKey,
        purpose: record.request.purpose,
        requestedBy: record.request.startedBy,
        existing: record.existing,
      },
    });
  }

  private onEvents(events: RawEventEnvelope[]): void {
    this.asks.onEvents(events);
    // A deleted member's orchestrator is retired (§D.1); its transcript stays, unseen.
    for (const e of events) {
      if (e.type !== "member.deleted") continue;
      const { memberId } = e.payload as { memberId: string };
      void this.roles
        .retirePerson(memberId)
        .catch((error) =>
          this.deps.log?.(
            `orchestration: retiring ${memberId}'s orchestrator: ${errorMessage(error)}`,
          ),
        );
    }
    const relevant = events.some(
      (e) =>
        e.type === "agent.turn.completed" ||
        e.type === "agent.turn.failed" ||
        e.type === "agent.turn.started" ||
        e.type === "inbox.created" ||
        // A session's repeat failure updates its open item (InboxService appends it alone).
        (e.type === "inbox.updated" && isRepeatFailure((e.payload as { item: InboxItem }).item)) ||
        e.type === "session.updated" ||
        e.type === "automation_run.updated" ||
        GITHUB_NOTICE_EVENTS.has(e.type),
    );
    if (!relevant) return;
    setImmediate(() => {
      try {
        this.cards.attach(events);
        this.delivery.onEvents(events);
        this.limits.onEvents(events);
        const session = (id: string) => this.deps.repo.find(id)?.session;
        const derived = [
          ...deriveNotices(events, {
            session,
            finalMessage: (sessionId, turnId) =>
              finalAssistantMessage(this.deps.db, sessionId, turnId),
            turnKind: (sessionId, turnId) => this.deps.repo.turn(sessionId, turnId)?.kind,
            mcpServer: (sessionId, itemId) => formServerOf(this.deps.repo, sessionId, itemId),
          }),
          ...deriveGithubNotices(events, session, this.deps.trustedAuthors),
        ];
        for (const { notice, wake } of derived) this.notify(notice, wake);
      } catch (error) {
        this.deps.log?.(`orchestration notices: ${errorMessage(error)}`);
      }
    });
  }

  /** Deliver pending notices to their target with one wake (called by the scheduler). */
  private async fire(key: string): Promise<WakeResult> {
    const target = parseWakeKey(key);
    const role: OrchestrationRole = target.role;
    const projectId = target.role === "pm" ? target.projectId : null;
    const person = target.role === "orchestrator" ? target.person : null;
    if (this.notices.undelivered(role, projectId, person).length === 0) return "empty";
    // An archived project's sessions take no input (§13): its PM isn't woken, or started.
    if (inArchivedProject(this.deps.projects, { projectId })) return "empty";
    // A deleted member's orchestrator is retired (§D.1): nothing wakes it again.
    if (person && !this.members().find(person)) return "empty";
    const session = await this.roles.ensure(role, projectId ?? person);
    if (isActiveSession(session)) return "busy";
    await this.deps.sessions.send(
      session.id,
      { input: { text: WAKE_TEXT, attachments: [] }, whenBusy: "reject" },
      "codeden",
    );
    return "sent";
  }

  private projectName(id: string): string {
    try {
      return this.deps.projects.get(id).name;
    } catch {
      return id;
    }
  }
}

/**
 * An orchestrator message to a PM, marked when it passes on the user's own request (a turn the
 * user started), so the PM's turn carries the user's authority (`LoopGuard.turnStarted`), and
 * with the person the orchestrator acts for, whose role the PM's turn acts with (§D.2).
 */
function relayed(input: UserInput, forUser: boolean, onBehalfOf?: string): UserInput {
  return {
    ...input,
    ...(forUser ? { relayedForUser: true } : {}),
    ...(onBehalfOf ? { onBehalfOf } : {}),
  };
}
