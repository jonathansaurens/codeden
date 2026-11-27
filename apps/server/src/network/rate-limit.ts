/** Failures allowed before each attempt has to wait. */
const FREE_FAILURES = 3;
/** First wait once the free failures are used up; it doubles with each failure. */
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/** This many failures inside the window lock the address out. */
const LOCKOUT_FAILURES = 10;
/** Password checks one key may have running at once. */
const MAX_IN_FLIGHT = 1;
const WINDOW_MS = 15 * 60_000;
const LOCKOUT_MS = 15 * 60_000;

interface Failure {
  at: number;
  /** What was tried (a member's name), so a success clears only its own; null: nothing to clear. */
  target: string | null;
}

interface AddressRecord {
  /** Failures inside the window, oldest first. */
  failures: Failure[];
  lockedUntil: number;
}

export type SignInGate =
  | { allowed: true }
  | { allowed: false; reason: "rate_limited" | "locked_out"; retryAfterMs: number };

/**
 * Sign-in throttling per client address (§15.1). Only failed attempts count. After three
 * failures each attempt waits 1 s, 2 s, 4 s … up to 30 s after the last failure; ten failures
 * within 15 minutes lock the address out for 15 minutes. Other addresses are unaffected. A
 * successful sign-in clears only the address's failures for the same target (the member it
 * signed in as), so signing in to one's own account never resets guessing at someone else's;
 * failures with no target (invite secrets, agent tokens) only age out. Kept in memory: a
 * restart forgets it.
 */
export class SignInLimiter {
  private readonly records = new Map<string, AddressRecord>();
  /** Password checks running now, per key: hashing is slow, so overlapping attempts can't all pass the gate. */
  private readonly inFlight = new Map<string, number>();

  private readonly freeFailures: number;
  private readonly lockoutFailures: number;

  /** `limits` loosens the thresholds, for the one shared limit across a trusted proxy's devices. */
  constructor(
    private readonly now: () => number = Date.now,
    limits: { freeFailures?: number; lockoutFailures?: number } = {},
  ) {
    this.freeFailures = limits.freeFailures ?? FREE_FAILURES;
    this.lockoutFailures = limits.lockoutFailures ?? LOCKOUT_FAILURES;
  }

  /** Wait required before the `failures`-th failure may be followed by another attempt. */
  static delayAfter(failures: number): number {
    return SignInLimiter.delayWith(failures, FREE_FAILURES);
  }

  private static delayWith(failures: number, freeFailures: number): number {
    if (failures < freeFailures) return 0;
    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failures - freeFailures));
  }

  /** May `address` try a password now? */
  check(address: string): SignInGate {
    const record = this.prune(address);
    if (!record) return { allowed: true };
    const now = this.now();
    if (record.lockedUntil > now) {
      return { allowed: false, reason: "locked_out", retryAfterMs: record.lockedUntil - now };
    }
    const last = record.failures.at(-1)?.at;
    const wait =
      last === undefined
        ? 0
        : last + SignInLimiter.delayWith(record.failures.length, this.freeFailures) - now;
    return wait > 0
      ? { allowed: false, reason: "rate_limited", retryAfterMs: wait }
      : { allowed: true };
  }

  /**
   * `check`, then reserve the key for one password check: it stays reserved until `release`,
   * and a second attempt for the same key meanwhile waits (the failure it may be about to
   * cause isn't counted yet). Always pair an allowed result with `release` (a `finally`).
   */
  acquire(address: string): SignInGate {
    const gate = this.check(address);
    if (!gate.allowed) return gate;
    if ((this.inFlight.get(address) ?? 0) >= MAX_IN_FLIGHT) {
      return { allowed: false, reason: "rate_limited", retryAfterMs: BASE_DELAY_MS };
    }
    this.inFlight.set(address, (this.inFlight.get(address) ?? 0) + 1);
    return gate;
  }

  /** End the reservation `acquire` made. */
  release(address: string): void {
    const left = (this.inFlight.get(address) ?? 1) - 1;
    if (left <= 0) this.inFlight.delete(address);
    else this.inFlight.set(address, left);
  }

  /** Record a wrong password from `address`, for `target` (who it tried to sign in as). */
  fail(address: string, target: string | null = null): void {
    const now = this.now();
    const record = this.prune(address) ?? { failures: [], lockedUntil: 0 };
    record.failures.push({ at: now, target });
    if (record.failures.length >= this.lockoutFailures) {
      record.lockedUntil = now + LOCKOUT_MS;
      record.failures = [];
    }
    this.records.set(address, record);
  }

  /** A correct password for `target`: forget the address's failures for that target only. */
  succeed(address: string, target: string): void {
    const record = this.prune(address);
    if (!record) return;
    record.failures = record.failures.filter((f) => f.target !== target);
    if (record.failures.length === 0 && record.lockedUntil <= this.now()) {
      this.records.delete(address);
    }
  }

  /** Drop failures older than the window; returns the record if anything is left. */
  private prune(address: string): AddressRecord | undefined {
    const record = this.records.get(address);
    if (!record) return undefined;
    const now = this.now();
    record.failures = record.failures.filter((f) => now - f.at < WINDOW_MS);
    if (record.failures.length === 0 && record.lockedUntil <= now) {
      this.records.delete(address);
      return undefined;
    }
    return record;
  }
}
