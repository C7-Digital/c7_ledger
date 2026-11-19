// A retry loop for a ledger submit that cannot apply the command twice.
//
// The loop composes the submit classifiers (`submitClassify.ts`). It keeps one
// `commandId` for all attempts, so the participant's command deduplication
// stops a second apply when an earlier attempt committed. The caller gives the
// command id and the attempt budgets. The loop gives Canton's meaning of each
// answer:
//
//   - `DUPLICATE_COMMAND` (isAlreadyApplied): an earlier attempt committed. The
//     result is `alreadyApplied`.
//   - an indeterminate failure (isIndeterminateSubmit: 503, Canton `deadline`,
//     SUBMISSION_ALREADY_IN_FLIGHT): the command can still commit. The loop
//     changes to the settle phase, which waits a fixed time between attempts
//     until the participant gives a definite answer.
//   - a retriable failure (isRetriableSubmit, or the caller's `retryAlso`): the
//     loop waits with exponential backoff and tries again.
//   - any other failure, for example a definite rejection such as
//     SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT (category `invalidState`): the loop
//     throws it at once. A retry of a definite rejection cannot succeed.

import { httpStatusOf } from "./error";
import { logger } from "./logger";
import {
  isAlreadyApplied,
  isIndeterminateSubmit,
  isRetriableSubmit,
  isSubmissionInFlight,
} from "./submitClassify";

/** The longest delay that `setTimeout` accepts. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The budget for retriable failures: exponential backoff. */
export interface RetryBudget {
  /** All attempts in this phase, the first attempt included. At least 1. */
  attempts: number;
  /** The delay before the second attempt. Each later delay is two times longer. */
  initialDelayMs: number;
  /** The longest delay between two attempts. */
  maxDelayMs: number;
}

/** The budget after an indeterminate failure: a fixed delay. */
export interface SettleBudget {
  /** All attempts in the settle phase, the attempt that went indeterminate included. At least 1. */
  attempts: number;
  /** The delay between two attempts. */
  delayMs: number;
}

/** The phase of the loop. */
export type RetryPhase = "retry" | "settle";

/** What the loop tells `onRetry` before it waits. */
export interface RetryEvent {
  /** The attempt that failed, counted from 1 over all phases. */
  attempt: number;
  phase: RetryPhase;
  /** The wait before the next attempt. */
  delayMs: number;
  /** The failure of this attempt. */
  error: unknown;
  /** The HTTP status of the failure, when it has one. */
  status: number | undefined;
  /** True when the participant still processes this command (SUBMISSION_ALREADY_IN_FLIGHT). */
  inFlight: boolean;
}

/** What one attempt gets. */
export interface SubmitAttempt {
  /** The same value on every attempt. Give it to the submit as its `commandId`. */
  commandId: string;
  /** The attempt number, from 1. */
  attempt: number;
}

export interface RetrySubmitOptions {
  /** The command id for all attempts. */
  commandId: string;
  /** The budget for retriable failures. */
  retry: RetryBudget;
  /**
   * The budget after an indeterminate failure. When it is not given, the
   * settle phase uses `retry.attempts` and `retry.maxDelayMs`.
   */
  settle?: SettleBudget;
  /**
   * Other failures to retry in the retry phase, for example an expired access
   * token when the operation gets a new token on each attempt. The loop asks
   * this only for a failure that is not already applied, not retriable and not
   * indeterminate.
   */
  retryAlso?: (error: unknown) => boolean;
  /** Called before each wait. A throw or a rejection from it is logged and has no other effect. */
  onRetry?: (event: RetryEvent) => unknown;
  /** Waits `ms` milliseconds. The default uses `setTimeout`. Tests give their own. */
  sleep?: (ms: number) => Promise<void>;
}

/** The result of a submit that did not fail. */
export type SubmitOutcome<T> =
  | { kind: "submitted"; value: T; attempts: number }
  | { kind: "alreadyApplied"; attempts: number };

/**
 * The settle phase used all its attempts, and the participant gave no definite
 * answer. The command can still commit. Do not submit it again with a new
 * command id: that can apply it twice.
 */
export class SubmitUnsettledError extends Error {
  readonly commandId: string;
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(commandId: string, attempts: number, lastError: unknown) {
    super(`The outcome of command ${commandId} is unknown after ${attempts} attempts`);
    this.name = "SubmitUnsettledError";
    this.commandId = commandId;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Runs `op` until it succeeds, the command is already applied, a failure is
 * not retriable, or the budget ends. Each attempt gets the same `commandId`.
 *
 * The operation runs again on each attempt, so it can get a new `Ledger` (with
 * a new token) each time.
 *
 * Throws the last failure when it is not retriable or when the retry budget
 * ends. Throws {@link SubmitUnsettledError} when the settle budget ends.
 * Throws a `RangeError` for a budget that is not valid.
 */
export async function retrySubmit<T>(
  op: (attempt: SubmitAttempt) => Promise<T>,
  options: RetrySubmitOptions,
): Promise<SubmitOutcome<T>> {
  const retry = checkedRetry(options.retry);
  const settle = checkedSettle(options.settle, retry);
  const sleep = options.sleep ?? defaultSleep;
  const { commandId } = options;

  let attempt = 0;
  let phaseAttempt = 0;
  let phase: RetryPhase = "retry";
  while (true) {
    attempt += 1;
    phaseAttempt += 1;
    let error: unknown;
    try {
      const value = await op({ commandId, attempt });
      return { kind: "submitted", value, attempts: attempt };
    } catch (e) {
      error = e;
    }
    if (isAlreadyApplied(error)) {
      return { kind: "alreadyApplied", attempts: attempt };
    }
    const indeterminate = isIndeterminateSubmit(error);
    const retriable =
      indeterminate ||
      isRetriableSubmit(error) ||
      (phase === "retry" && callerRetries(options.retryAlso, error));
    if (!retriable) throw error;
    // The first indeterminate failure starts the settle phase with its own
    // budget, so the retries before it do not make the settle window shorter.
    if (phase === "retry" && indeterminate) {
      phase = "settle";
      phaseAttempt = 1;
    }
    const attempts = phase === "settle" ? settle.attempts : retry.attempts;
    if (phaseAttempt >= attempts) {
      if (phase === "settle") throw new SubmitUnsettledError(commandId, attempt, error);
      throw error;
    }
    const delayMs =
      phase === "settle"
        ? settle.delayMs
        : backoffDelay(retry, phaseAttempt);
    await notify(options.onRetry, {
      attempt,
      phase,
      delayMs,
      error,
      status: httpStatusOf(error),
      inFlight: isSubmissionInFlight(error),
    });
    await sleep(delayMs);
  }
}

function callerRetries(
  retryAlso: ((error: unknown) => boolean) | undefined,
  error: unknown,
): boolean {
  if (retryAlso === undefined) return false;
  try {
    return retryAlso(error) === true;
  } catch (e) {
    logger.warn("retrySubmit: retryAlso threw; the failure is not retried", e);
    return false;
  }
}

async function notify(
  onRetry: ((event: RetryEvent) => unknown) | undefined,
  event: RetryEvent,
): Promise<void> {
  if (onRetry === undefined) return;
  try {
    await onRetry(event);
  } catch (e) {
    logger.warn("retrySubmit: onRetry failed", e);
  }
}

function backoffDelay(retry: RetryBudget, phaseAttempt: number): number {
  // 2 ** 1024 is Infinity, and Math.min then gives maxDelayMs.
  return Math.min(retry.initialDelayMs * 2 ** (phaseAttempt - 1), retry.maxDelayMs);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, MAX_TIMER_DELAY_MS)));
}

function checkedAttempts(name: string, attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError(`${name} must be an integer of 1 or more, not ${attempts}`);
  }
  return attempts;
}

function checkedDelay(name: string, ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`${name} must be a finite number of 0 or more, not ${ms}`);
  }
  return ms;
}

function checkedRetry(retry: RetryBudget): RetryBudget {
  const initialDelayMs = checkedDelay("retry.initialDelayMs", retry.initialDelayMs);
  const maxDelayMs = checkedDelay("retry.maxDelayMs", retry.maxDelayMs);
  if (maxDelayMs < initialDelayMs) {
    throw new RangeError(
      `retry.maxDelayMs (${maxDelayMs}) must not be less than retry.initialDelayMs (${initialDelayMs})`,
    );
  }
  return {
    attempts: checkedAttempts("retry.attempts", retry.attempts),
    initialDelayMs,
    maxDelayMs,
  };
}

function checkedSettle(settle: SettleBudget | undefined, retry: RetryBudget): SettleBudget {
  if (settle === undefined) {
    return { attempts: retry.attempts, delayMs: retry.maxDelayMs };
  }
  return {
    attempts: checkedAttempts("settle.attempts", settle.attempts),
    delayMs: checkedDelay("settle.delayMs", settle.delayMs),
  };
}
