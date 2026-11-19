// A retry loop for a ledger submit that cannot apply the command twice.
//
// The loop composes the submit classifiers (`submitClassify.ts`). It keeps one
// `commandId` for all attempts, so the participant's command deduplication
// stops a second apply when an earlier attempt committed. This holds only when
// every attempt goes to the same participant with the same change id (user id,
// `actAs` and command id), and only inside the deduplication period. So the
// caller gives the deduplication period, and the loop does not resubmit after
// an indeterminate failure when the period can end before the next attempt.
// The caller gives the command id and the attempt budgets. The loop gives
// Canton's meaning of each answer:
//
//   - `DUPLICATE_COMMAND` (isAlreadyApplied): an earlier attempt committed. The
//     result is `alreadyApplied`. The participant interprets a command before
//     it checks for a duplicate, so only a command that still interprets gets
//     this answer. When the earlier attempt archived a contract that the
//     command uses (a consuming exercise or an archive), the resubmit gets
//     CONTRACT_NOT_FOUND. In the settle phase, that ends as
//     SubmitUnsettledError, because the error does not show which submit
//     archived the contract.
//   - an indeterminate failure (isIndeterminateSubmit: 503, Canton `deadline`,
//     SUBMISSION_ALREADY_IN_FLIGHT): the command can still commit. The loop
//     changes to the settle phase, which waits a fixed time between attempts
//     until the participant gives a definite answer. In the settle phase, only
//     a success or DUPLICATE_COMMAND settles the outcome. Every other end of
//     the loop throws SubmitUnsettledError, because a later failure does not
//     show whether the earlier attempt committed.
//   - a retriable failure (isRetriableSubmit, or the caller's `retryAlso`): the
//     loop waits with exponential backoff and tries again.
//   - a node with no traffic credit (isOutOfTraffic): the loop throws at once,
//     also when `retryAlso` accepts the failure. Canton files it as retryable,
//     but a retry cannot succeed and spends more of the node's traffic.
//   - any other failure that is not retriable: the loop throws it at once.

import { httpStatusOf } from "./error";
import { logger } from "./logger";
import {
  isAlreadyApplied,
  isIndeterminateSubmit,
  isOutOfTraffic,
  isRetriableSubmit,
  isSubmissionInFlight,
} from "./submitClassify";

/** The longest delay that `setTimeout` accepts. A longer wait uses more timers. */
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
  /** The command id for all attempts. It must not be empty. */
  commandId: string;
  /**
   * The deduplication period of the command, in milliseconds: the period that
   * the submit sets, or the participant's maximum deduplication duration when
   * the submit sets none. After an indeterminate failure, the loop does not
   * resubmit when the next attempt can start after this period, counted from
   * the start of the attempt that went indeterminate. It throws
   * SubmitUnsettledError instead.
   */
  deduplicationMs: number;
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
   * this only for a failure that is not already applied, not retriable, not
   * indeterminate and not a lack of traffic.
   */
  retryAlso?: (error: unknown) => boolean;
  /** Called before each wait. A throw or a rejection from it is logged and has no other effect. */
  onRetry?: (event: RetryEvent) => unknown;
  /** Waits `ms` milliseconds. The default uses `setTimeout`. Tests give their own. */
  sleep?: (ms: number) => Promise<void>;
  /** The current time in milliseconds. The default is `Date.now`. Tests give their own. */
  now?: () => number;
}

/** The result of a submit that did not fail. */
export type SubmitOutcome<T> =
  | { kind: "submitted"; value: T; attempts: number }
  | { kind: "alreadyApplied"; attempts: number };

/**
 * An attempt went indeterminate, and the loop ended before the participant
 * gave a definite answer: the settle budget or the deduplication period ended,
 * or a later attempt failed in a way that does not settle the outcome. The
 * command can still have committed, or can still commit. Do not submit it again
 * with a new command id: that can apply it twice. `lastError` is the failure
 * of the last attempt.
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
 * Before any attempt went indeterminate, throws the last failure when it is
 * not retriable or when the retry budget ends. After an attempt went
 * indeterminate, throws {@link SubmitUnsettledError} for every end other than a
 * success or `alreadyApplied`. Throws a `RangeError` for an empty command id or
 * a budget that is not valid, before it runs `op`.
 *
 * A command that archives a contract (a consuming exercise or an archive)
 * almost never gives `alreadyApplied`: when an earlier attempt committed, the
 * resubmit fails with `CONTRACT_NOT_FOUND`, and the loop throws
 * {@link SubmitUnsettledError}. To settle it, read the ledger again.
 */
export async function retrySubmit<T>(
  op: (attempt: SubmitAttempt) => Promise<T>,
  options: RetrySubmitOptions,
): Promise<SubmitOutcome<T>> {
  const commandId = checkedCommandId(options.commandId);
  const retry = checkedRetry(options.retry);
  const settle = checkedSettle(options.settle, retry);
  const deduplicationMs = checkedDuration("deduplicationMs", options.deduplicationMs);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  let attempt = 0;
  let phaseAttempt = 0;
  let phase: RetryPhase = "retry";
  // The start of the attempt that went indeterminate first. The command can
  // have committed from this time, so the deduplication period counts from it.
  let settleFrom = 0;
  while (true) {
    attempt += 1;
    phaseAttempt += 1;
    const startedAt = now();
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
      !isOutOfTraffic(error) &&
      (indeterminate ||
        isRetriableSubmit(error) ||
        (phase === "retry" && callerRetries(options.retryAlso, error)));
    // The first indeterminate failure starts the settle phase with its own
    // budget, so the retries before it do not make the settle window shorter.
    if (phase === "retry" && indeterminate) {
      phase = "settle";
      phaseAttempt = 1;
      settleFrom = startedAt;
    }
    // In the settle phase, an end of the loop does not settle the outcome.
    const fail = (): unknown =>
      phase === "settle" ? new SubmitUnsettledError(commandId, attempt, error) : error;
    if (!retriable) throw fail();
    const attempts = phase === "settle" ? settle.attempts : retry.attempts;
    if (phaseAttempt >= attempts) throw fail();
    const delayMs =
      phase === "settle"
        ? settle.delayMs
        : backoffDelay(retry, phaseAttempt);
    if (phase === "settle" && now() + delayMs - settleFrom >= deduplicationMs) {
      throw fail();
    }
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
  // 0 * Infinity is NaN, so a zero delay stays zero before the power.
  if (retry.initialDelayMs === 0) return 0;
  // 2 ** 1024 is Infinity, and Math.min then gives maxDelayMs.
  return Math.min(retry.initialDelayMs * 2 ** (phaseAttempt - 1), retry.maxDelayMs);
}

/** Waits the full `ms`, in steps that `setTimeout` accepts. */
async function defaultSleep(ms: number): Promise<void> {
  let remaining = ms;
  do {
    const step = Math.min(remaining, MAX_TIMER_DELAY_MS);
    await new Promise<void>((resolve) => setTimeout(resolve, step));
    remaining -= step;
  } while (remaining > 0);
}

function checkedCommandId(commandId: string): string {
  if (typeof commandId !== "string" || commandId.trim() === "") {
    // Ledger.submit makes a new command id for an empty one, so each attempt
    // would be a new command, and deduplication could not stop a second apply.
    throw new RangeError("commandId must not be empty");
  }
  return commandId;
}

function checkedDuration(name: string, ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`${name} must be a finite number above 0, not ${ms}`);
  }
  return ms;
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
