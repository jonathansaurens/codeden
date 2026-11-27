import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessSupervisor } from "../src/process/supervisor";
import { removeWorkspace } from "../src/workspace/removal";
import { prepareWorkspace } from "../src/workspace/worktree";
import { makeRepo, removeDir, sh, tempDir, write } from "./helpers";

/**
 * `workspace.prepare` with `clone` and `perProject` (`docs/machines-teams-and-agents.md` §A.4):
 * a machine's runner keeps one clone per project, fetched before each session, and gives each
 * session a worktree of it instead of a clone of its own.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) removeDir(dir);
});

function setup() {
  const work = makeRepo({ "README.md": "# demo\n" });
  const bare = tempDir("codeden-bare-");
  const home = tempDir("codeden-machine-home-");
  dirs.push(work, bare, home);
  sh(bare, "init", "-q", "--bare", "-b", "main");
  sh(work, "remote", "add", "origin", bare);
  sh(work, "push", "-q", "origin", "main");
  const ctx = { home, supervisor: new ProcessSupervisor(), emit: () => undefined };
  return { work, bare, home, ctx };
}

const prepare = (sessionId: string, remoteUrl: string, branch: string) => ({
  name: "workspace.prepare" as const,
  sessionId,
  strategy: "clone" as const,
  remoteUrl,
  branch,
  perProject: true,
  projectSlug: "demo",
  fetch: true,
  setupCommands: [],
});

describe("workspace.prepare with a clone per project", () => {
  it("clones the project once and gives each session a worktree of it", async () => {
    const { bare, home, ctx } = setup();
    const first = await prepareWorkspace(prepare("sess-aaaa1111", bare, "codeden/one"), ctx);
    const repo = join(home, "repos", "demo");
    expect(first).toMatchObject({
      cwd: join(home, "wt", "demo", "sessaaaa"),
      branch: "codeden/one",
      created: true,
      repoPath: repo,
    });
    expect(sh(first.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("codeden/one");

    const second = await prepareWorkspace(prepare("sess-bbbb2222", bare, "codeden/two"), ctx);
    expect(second.cwd).toBe(join(home, "wt", "demo", "sessbbbb"));
    expect(second.repoPath).toBe(repo);
    const worktrees = sh(repo, "worktree", "list", "--porcelain");
    expect(worktrees).toContain(first.cwd);
    expect(worktrees).toContain(second.cwd);
  });

  it("fetches before each session, so a new worktree starts from the remote as it is now", async () => {
    const { work, bare, ctx } = setup();
    await prepareWorkspace(prepare("sess-cccc3333", bare, "codeden/old"), ctx);
    write(work, "new.txt", "landed on main\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "new");
    sh(work, "push", "-q", "origin", "main");
    const next = await prepareWorkspace(prepare("sess-dddd4444", bare, "codeden/new"), ctx);
    expect(readFileSync(join(next.cwd, "new.txt"), "utf8")).toBe("landed on main\n");
  });

  it("brings a removed worktree back on its branch, with its commits", async () => {
    const { bare, home, ctx } = setup();
    const made = await prepareWorkspace(prepare("sess-eeee5555", bare, "codeden/keep"), ctx);
    write(made.cwd, "work.txt", "committed\n");
    sh(made.cwd, "add", "-A");
    sh(made.cwd, "commit", "-q", "-m", "work");
    await removeWorkspace(
      { name: "workspace.remove", repoPath: made.repoPath as string, path: made.cwd },
      home,
    );
    const back = await prepareWorkspace(prepare("sess-eeee5555", bare, "codeden/keep"), ctx);
    expect(back.cwd).toBe(made.cwd);
    expect(readFileSync(join(back.cwd, "work.txt"), "utf8")).toBe("committed\n");
  });
});
