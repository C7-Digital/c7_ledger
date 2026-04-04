/**
 * Models the Canton base rate traffic balance with linear recovery.
 *
 * The base rate balance:
 * - Starts at burstAmount (200KB on mainnet as of 2026-04-04)
 * - Decreases by the cost of each submitted transaction
 * - Recovers linearly: recoveryRate = burstAmount / burstWindowMs bytes per ms
 * - Caps at burstAmount (never exceeds max)
 *
 * Since no API exposes the actual base rate balance, we maintain
 * a conservative local estimate and track our own submissions.
 */
export interface BudgetTrackerOptions {
  /**
   * Burst amount in bytes (the full budget for the window).
   * Mainnet (live 2026-04-04): 200,000 bytes (~195 KB).
   * Always query AmuletRules for the live value — SVs can change this.
   */
  burstAmount: number;

  /**
   * Burst window in milliseconds.
   * Mainnet: 1,200,000 ms (20 minutes).
   */
  burstWindowMs: number;

  /**
   * Safety margin (0–1). Reserve this fraction of budget as buffer
   * for background traffic (ACS commitments, topology txns) and
   * estimation inaccuracy. Default: 0.1 (10%).
   */
  safetyMargin?: number;

  /**
   * Optional: start with a custom initial balance (e.g. from a saved state).
   * Defaults to burstAmount (assumes full budget available).
   */
  initialBalance?: number;
}

export class BudgetTracker {
  private balance: number;
  private lastUpdateTime: number;
  private readonly burstAmount: number;
  private readonly recoveryRatePerMs: number;
  private readonly safetyMargin: number;
  private readonly effectiveBudget: number;

  constructor(options: BudgetTrackerOptions) {
    this.burstAmount = options.burstAmount;
    this.safetyMargin = options.safetyMargin ?? 0.1;
    this.effectiveBudget = this.burstAmount * (1 - this.safetyMargin);
    this.recoveryRatePerMs = this.burstAmount / options.burstWindowMs;
    this.balance = options.initialBalance ?? this.burstAmount;
    this.lastUpdateTime = Date.now();
  }

  private updateBalance(): void {
    const now = Date.now();
    const elapsed = now - this.lastUpdateTime;
    if (elapsed > 0) {
      this.balance = Math.min(
        this.burstAmount,
        this.balance + elapsed * this.recoveryRatePerMs,
      );
      this.lastUpdateTime = now;
    }
  }

  /** Record a submission's traffic cost, reducing available balance. */
  recordSubmission(bytes: number): void {
    this.updateBalance();
    this.balance = Math.max(0, this.balance - bytes);
  }

  /** Get current estimated available balance (includes recovery since last update). */
  getAvailableBalance(): number {
    this.updateBalance();
    return this.balance;
  }

  /** Effective budget after safety margin. */
  getEffectiveBudget(): number {
    return this.effectiveBudget;
  }

  /** Check if a transaction of given size can be submitted now without exceeding the safe budget. */
  canSubmit(estimatedBytes: number): boolean {
    return this.getAvailableBalance() >= estimatedBytes + (this.burstAmount - this.effectiveBudget);
  }

  /**
   * Estimate wait time in ms until a transaction of given size can fit.
   * Returns 0 if it can be submitted immediately.
   */
  /**
   * Estimate wait time in ms until a transaction of given size can fit.
   * Returns 0 if it can be submitted immediately.
   * Returns Infinity if the transaction can never fit (larger than effective budget).
   */
  estimateWaitMs(estimatedBytes: number): number {
    if (this.canSubmit(estimatedBytes)) return 0;
    // A transaction larger than the effective budget can never be submitted
    if (estimatedBytes > this.effectiveBudget) return Infinity;
    const deficit =
      estimatedBytes + (this.burstAmount - this.effectiveBudget) - this.getAvailableBalance();
    return Math.ceil(deficit / this.recoveryRatePerMs);
  }

  /**
   * Recalibrate from actual traffic cost (e.g. from paid_traffic_cost on completion).
   * Adjusts internal estimate if actual differs from estimated.
   */
  recalibrateFromActual(estimatedBytes: number, actualBytes: number): void {
    const diff = estimatedBytes - actualBytes;
    // If we overestimated, give back the difference
    // If we underestimated, deduct more
    this.balance = Math.max(0, Math.min(this.burstAmount, this.balance + diff));
  }

  /** Reset to full balance (e.g., after extended idle period). */
  reset(): void {
    this.balance = this.burstAmount;
    this.lastUpdateTime = Date.now();
  }

  /** Current state snapshot for diagnostics. */
  snapshot(): BudgetSnapshot {
    this.updateBalance();
    return {
      balance: this.balance,
      burstAmount: this.burstAmount,
      effectiveBudget: this.effectiveBudget,
      safetyMargin: this.safetyMargin,
      recoveryRatePerMs: this.recoveryRatePerMs,
      utilization: 1 - this.balance / this.burstAmount,
    };
  }
}

export interface BudgetSnapshot {
  balance: number;
  burstAmount: number;
  effectiveBudget: number;
  safetyMargin: number;
  recoveryRatePerMs: number;
  utilization: number;
}
