import { RunnerBackendId } from "@codeden/contracts";
import { defaultRunnerLaunch, findOrStartRunner, homePaths } from "@codeden/server";

/**
 * `codeden runner --home <dir> --detach [--backend <id>] [--fake]`: start a runner in `home` as a
 * detached process that outlives this command, unless one is already alive and answering there
 * (`docs/machines-teams-and-agents.md` §A.3). The server runs it on a machine over `ssh` before
 * every link. It prints only to stderr, so it can run ahead of `runner-link` on one channel.
 */
export async function runnerCommand(
  home: string,
  opts: { detach: boolean; backend?: string; fake: boolean },
): Promise<number> {
  if (!opts.detach) {
    console.error("Usage: codeden runner --home <dir> --detach [--backend ssh] [--fake]");
    return 2;
  }
  const backend = RunnerBackendId.safeParse(opts.backend ?? "local");
  if (!backend.success) {
    console.error(`codeden runner: unknown --backend "${opts.backend}"`);
    return 2;
  }
  const launch = defaultRunnerLaunch(["--backend", backend.data, ...(opts.fake ? ["--fake"] : [])]);
  if (!launch) {
    console.error("codeden runner: this copy of CodeDen has no runner to start");
    return 1;
  }
  try {
    const lock = await findOrStartRunner({
      home,
      lockFile: homePaths(home).runnerLock,
      launch,
      onStarting: () => console.error(`codeden runner: starting a runner in ${home}`),
      onSlow: () => console.error("codeden runner: the runner is taking a while to start"),
    });
    console.error(`codeden runner: running (pid ${lock.pid})`);
    return 0;
  } catch (error) {
    console.error(`codeden runner: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
