/**
 * Automatic placement's scorer (`docs/machines-teams-and-agents.md` §A.5): pure, so every rule
 * is unit tested. Given each candidate (Home and every machine) with its preference, whether it
 * can take the session, and its last capacity answer, it picks the one with the most free
 * capacity weighted by preference:
 *
 *     score = preference × cpuCount × (1 − cpuBusy) × (availableMemory ÷ totalMemory)
 *
 * A candidate is skipped when it isn't connected, its preference is 0 (Manual only), the
 * project can't run there, its provider isn't ready there, its CPU is 95% busy or more, its free
 * memory is 5% or less, or its capacity answer is missing or older than 15 s. Ties go to Home,
 * then to the higher preference, then to the label that sorts first, so the choice is stable.
 */

/** What a capacity answer holds (`HostResources`). */
export interface Capacity {
  cpuCount: number;
  /** Share of CPU time busy over the sample, 0 to 1. */
  cpuBusy: number;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  /** When it was sampled (ms since the epoch). */
  sampledAtMs: number;
}

/** One place a session could run. */
export interface Candidate {
  /** Its runner record id. */
  id: string;
  /** Shown in reasons: "Home", "vps-1". */
  label: string;
  home: boolean;
  /** Its preference (`MachineWeight`): 100, 50, 25 or 0. */
  weight: number;
  connected: boolean;
  /** Whether the project may run there (machines: GitHub projects only). */
  projectAllowed: boolean;
  /** Whether the session's provider is installed, enabled and signed in there. */
  providerReady: boolean;
  capacity: Capacity | null;
}

/** Why a candidate was skipped. */
export type SkipReason =
  | "disconnected"
  | "manual_only"
  | "project_not_allowed"
  | "provider_not_ready"
  | "no_capacity"
  | "stale_capacity"
  | "cpu_busy"
  | "memory_low";

export type Scored =
  | { candidate: Candidate; score: number; skipped?: undefined }
  | { candidate: Candidate; score?: undefined; skipped: SkipReason };

export interface Choice {
  /** The winner; null when no candidate qualifies. */
  winner: Candidate | null;
  /** Every candidate with its score or why it was skipped, in the order given. */
  scored: Scored[];
}

/** A capacity answer older than this doesn't count. */
export const CAPACITY_MAX_AGE_MS = 15_000;
/** At or above this CPU share a candidate is too busy. */
export const CPU_BUSY_LIMIT = 0.95;
/** At or below this free memory share a candidate is too full. */
export const MEMORY_FREE_LIMIT = 0.05;

/** A candidate's score, or why it doesn't qualify. */
export function scoreCandidate(c: Candidate, nowMs: number): Scored {
  const skip = (skipped: SkipReason): Scored => ({ candidate: c, skipped });
  if (!c.connected) return skip("disconnected");
  if (c.weight <= 0) return skip("manual_only");
  if (!c.projectAllowed) return skip("project_not_allowed");
  if (!c.providerReady) return skip("provider_not_ready");
  const cap = c.capacity;
  if (!cap || cap.cpuCount <= 0 || cap.totalMemoryBytes <= 0) return skip("no_capacity");
  if (nowMs - cap.sampledAtMs > CAPACITY_MAX_AGE_MS) return skip("stale_capacity");
  if (cap.cpuBusy >= CPU_BUSY_LIMIT) return skip("cpu_busy");
  const free = cap.availableMemoryBytes / cap.totalMemoryBytes;
  if (free <= MEMORY_FREE_LIMIT) return skip("memory_low");
  const idle = 1 - Math.min(Math.max(cap.cpuBusy, 0), 1);
  return { candidate: c, score: c.weight * cap.cpuCount * idle * Math.min(free, 1) };
}

/** Whether `a` wins a tie against `b`: Home first, then the higher preference, then the label. */
function beforeOnTie(a: Candidate, b: Candidate): boolean {
  if (a.home !== b.home) return a.home;
  if (a.weight !== b.weight) return a.weight > b.weight;
  return a.label.localeCompare(b.label) < 0;
}

/** Score every candidate and pick the highest. */
export function choosePlacement(candidates: readonly Candidate[], nowMs: number): Choice {
  const scored = candidates.map((c) => scoreCandidate(c, nowMs));
  let winner: { candidate: Candidate; score: number } | null = null;
  for (const s of scored) {
    if (s.score === undefined) continue;
    if (
      !winner ||
      s.score > winner.score ||
      (s.score === winner.score && beforeOnTie(s.candidate, winner.candidate))
    ) {
      winner = { candidate: s.candidate, score: s.score };
    }
  }
  return { winner: winner?.candidate ?? null, scored };
}

/**
 * Why nothing qualified, in a sentence a person can act on: "No machine has codex signed in",
 * "All machines are busy". Candidates the session could never use (disconnected, Manual only,
 * project not allowed) explain it only when nothing else does.
 */
export function noPlacementReason(scored: readonly Scored[], provider: string): string {
  const reasons = scored.flatMap((s) => (s.skipped ? [s.skipped] : []));
  const has = (r: SkipReason) => reasons.includes(r);
  if (reasons.length === 0) return "No machine can take sessions automatically";
  if (has("provider_not_ready") && reasons.every((r) => r !== "cpu_busy" && r !== "memory_low")) {
    return `No machine has ${provider} installed and signed in`;
  }
  if (has("cpu_busy") || has("memory_low")) return "All machines are busy";
  if (has("no_capacity") || has("stale_capacity")) {
    return "No machine answered with its free capacity in time";
  }
  if (reasons.every((r) => r === "manual_only")) {
    return "Every machine is set to Manual only";
  }
  if (has("project_not_allowed") && reasons.every((r) => r !== "disconnected")) {
    return "Machines need a GitHub project";
  }
  return "No machine is connected";
}
