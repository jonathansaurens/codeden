import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { RunnerCommandOf } from "@codeden/contracts";
import { CommandError } from "../errors";
import { type GitOptions, git, gitOk, gitText } from "../git/exec";
import { currentBranch, defaultBranch } from "../git/ops";

/** Where a project's shared clone lives on this runner (`docs/machines-teams-and-agents.md` §A.4). */
export function projectClonePath(home: string, slug: string): string {
  return resolve(join(home, "repos", slug));
}

/** Clone and fetch never run the `ext::` transport, whatever the user's git config allows. */
const SAFE = ["-c", "protocol.ext.allow=never"];
/** Written into the clone's `.git` once it is complete; one without it is cloned again. */
const READY_FILE = "codeden-clone-ready";
const GIT_MS = 10 * 60_000;

/**
 * The project's clone for `workspace.prepare` with `perProject` (§A.4): `<home>/repos/<slug>`,
 * cloned the first time and fetched (with the brokered credential, `git/credentials.ts`) every
 * time after, so each session's worktree starts from the remote as it is now. A fetch that
 * fails (offline) keeps the clone as it is. A folder there that isn't a clone of `remoteUrl` is
 * refused; a clone that never finished is made again.
 */
export async function ensureProjectClone(
  cmd: RunnerCommandOf<"workspace.prepare">,
  home: string,
): Promise<string> {
  const remoteUrl = cmd.remoteUrl as string;
  const path = projectClonePath(home, cmd.projectSlug as string);
  const auth: GitOptions = { timeoutMs: GIT_MS, credential: cmd.credential };
  if (existsSync(path) && readdirSync(path).length > 0) {
    const cdup = await gitText(path, ["rev-parse", "--show-cdup"]).catch(() => null);
    const origin =
      cdup === "" ? await gitText(path, ["remote", "get-url", "origin"]).catch(() => "") : "";
    if (cdup !== "" || origin !== remoteUrl) {
      throw new CommandError("path_exists", `${path} exists and is not a clone of the project`);
    }
    if (existsSync(join(path, ".git", READY_FILE))) {
      await git(path, [...SAFE, "fetch", "--prune", "origin"], auth).catch(() => undefined);
      return path;
    }
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  await mkdir(join(home, "repos"), { recursive: true });
  try {
    await git(join(home, "repos"), [...SAFE, "clone", "-q", "--", remoteUrl, path], auth);
    await writeFile(join(path, ".git", READY_FILE), "ready\n");
  } catch (error) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return path;
}

/**
 * Where a session's worktree in the project's clone starts: its own branch's remote copy when
 * it was pushed but isn't here (a session resumed on another machine), else `baseRef` (default:
 * the remote's default branch), preferring the freshly fetched `origin/` copy of a branch name.
 */
export async function projectCloneBase(
  repo: string,
  cmd: RunnerCommandOf<"workspace.prepare">,
): Promise<string> {
  const has = (ref: string) => gitOk(repo, ["rev-parse", "--verify", "--quiet", ref]);
  if (cmd.branch && !(await has(`refs/heads/${cmd.branch}`))) {
    if (await has(`refs/remotes/origin/${cmd.branch}`)) return `origin/${cmd.branch}`;
  }
  const base = cmd.baseRef ?? (await defaultBranch(repo)) ?? "HEAD";
  if (base === "HEAD" || base.startsWith("origin/")) return base;
  return (await has(`refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
}

/**
 * `clone` with `perProject` and `projectRoot` (a PM, `docs/machines-teams-and-agents.md` §D.4):
 * the project's clone itself, fetched, with its checked-out branch fast-forwarded to its remote
 * copy so the PM reads the code as it is on GitHub now. A branch that can't be fast-forwarded
 * (someone committed in the clone) is left as it is. Nothing is set up: the PM never builds.
 */
export async function projectRootClone(
  cmd: RunnerCommandOf<"workspace.prepare">,
  home: string,
): Promise<{ cwd: string; branch: string | null; created: boolean; repoPath: string }> {
  const repoPath = await ensureProjectClone(cmd, home);
  await git(repoPath, ["merge", "--ff-only", "-q", "@{upstream}"]).catch(() => undefined);
  return { cwd: repoPath, branch: await currentBranch(repoPath), created: false, repoPath };
}

/**
 * `folder` (§D.4): a folder of the runner's own home, made when missing, as the working directory
 * of an orchestrator on this runner (`orchestrator/<member id>`). Never outside the home.
 */
export async function homeFolder(
  cmd: RunnerCommandOf<"workspace.prepare">,
  home: string,
): Promise<{ cwd: string; branch: null; created: boolean }> {
  const root = resolve(home);
  const path = resolve(root, cmd.folder ?? "");
  const inside = relative(root, path);
  if (!cmd.folder || !inside || inside.startsWith("..") || inside.startsWith(sep)) {
    throw new CommandError(
      "bad_request",
      `${cmd.folder ?? ""} is not a folder of the runner's home`,
    );
  }
  await mkdir(path, { recursive: true });
  return { cwd: path, branch: null, created: false };
}
