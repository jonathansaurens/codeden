import type { Project, Session, WorkspaceRequest } from "@codeden/contracts";
import { ServiceError } from "../errors";
import type { GitBroker } from "../git-broker";
import type { RunnerPort } from "../runner-port";
import { slugWords } from "./conflicts";
import { type SetupGateDeps, seenSetups, settleSetup } from "./setup-gate";

/** What a prepared workspace is recorded as on the session. */
export interface PreparedWorkspace {
  cwd: string;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  /** Why the requested workspace could not be used, when CodeDen fell back. */
  fallback: string | null;
  /** A failed setup command, told to the agent with its first input. */
  setupNote: string | null;
  /** On a runner with per-project clones: the project's clone the worktree belongs to. */
  repoPath?: string | null;
}

/**
 * The workspace of a session on a runner that doesn't share the server's disk (a sandbox,
 * `docs/remote-runners.md` §9.1): the runner clones the project's `origin` into a folder it
 * chooses and checks out the session's branch (a new one, as for a worktree, or the default
 * branch for a `repo_root` session). The server never builds a path for it: `cwd` is whatever
 * the runner returns, and there is no worktree to clean up (the clone lives as long as its
 * sandbox). The credential for the clone is brokered for that one operation (§9.2).
 */
export async function prepareCloneWorkspace(
  git: GitBroker | undefined,
  runner: RunnerPort,
  session: Session,
  project: Project,
  req: WorkspaceRequest,
  opts: { fork: boolean; gate: SetupGateDeps },
): Promise<PreparedWorkspace> {
  if (opts.fork) {
    throw new ServiceError(
      400,
      "unsupported",
      "A session on a runner in a sandbox can't be forked yet",
    );
  }
  if (req.mode === "existing") {
    throw new ServiceError(
      400,
      "unsupported",
      "A runner in a sandbox can't use a folder on this machine; start it in a new worktree",
    );
  }
  const remoteUrl = git ? await git.cloneUrl(project) : null;
  if (!git || !remoteUrl) {
    throw new ServiceError(
      400,
      "clone_unavailable",
      "This project has no origin remote, so a runner in a sandbox can't clone it",
    );
  }
  const baseRef = req.baseRef ?? project.defaultBranch ?? undefined;
  const branch =
    req.branch ??
    (req.mode === "worktree"
      ? `codeden/${slugWords(session.title ?? session.purpose, 5, 40)}-${session.id.slice(0, 4)}`
      : baseRef);
  const credential = await git.credentialFor(runner, remoteUrl);
  // A machine keeps one clone per project, and the session gets a worktree of it (§A.4).
  const perProject = runner.remote?.().projectClones === true && req.mode === "worktree";
  const result = await runner.request(
    {
      name: "workspace.prepare",
      sessionId: session.id,
      strategy: "clone",
      remoteUrl,
      branch,
      baseRef,
      fetch: true,
      setupCommands: req.setupCommands ?? [],
      seenSetups: seenSetups(project),
      ...(credential ? { credential } : {}),
      ...(perProject ? { perProject: true, projectSlug: project.slug } : {}),
    },
    opts.gate.timeoutMs,
  );
  return {
    cwd: result.cwd,
    // A worktree of the machine's clone is removed with its session, as on Home; a clone of
    // its own lives as long as its sandbox.
    worktreePath: perProject ? result.cwd : null,
    repoPath: result.repoPath ?? null,
    branch: result.branch,
    baseBranch: req.mode === "worktree" ? (baseRef ?? null) : null,
    fallback: null,
    setupNote: await settleSetup(opts.gate, session, project, result),
  };
}

/**
 * A PM's workspace on a machine (`docs/machines-teams-and-agents.md` §D.4): the project's clone
 * there itself (`<runner home>/repos/<project>`), fetched and fast-forwarded, read-only, with no
 * worktree of its own and no setup. The same command brings it up to date before each turn.
 */
export async function prepareRoleClone(
  git: GitBroker | undefined,
  runner: RunnerPort,
  session: Session,
  project: Project,
  timeoutMs: number,
): Promise<PreparedWorkspace> {
  const remoteUrl = git ? await git.cloneUrl(project) : null;
  if (!git || !remoteUrl) {
    throw new ServiceError(
      400,
      "clone_unavailable",
      "This project has no origin remote, so a machine can't clone it for its PM",
    );
  }
  const credential = await git.credentialFor(runner, remoteUrl);
  const result = await runner.request(
    {
      name: "workspace.prepare",
      sessionId: session.id,
      strategy: "clone",
      remoteUrl,
      fetch: true,
      setupCommands: [],
      runProjectSetup: false,
      perProject: true,
      projectRoot: true,
      projectSlug: project.slug,
      ...(credential ? { credential } : {}),
    },
    timeoutMs,
  );
  return {
    cwd: result.cwd,
    // The clone is shared with the project's sessions there: never removed with the PM.
    worktreePath: null,
    repoPath: null,
    branch: result.branch,
    baseBranch: null,
    fallback: null,
    setupNote: null,
  };
}
