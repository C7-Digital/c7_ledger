import { jest } from "@jest/globals";
import { BudgetTracker } from "./budget-tracker";

// Mainnet-like defaults
const BURST = 200_000; // 200KB
const WINDOW = 1_200_000; // 20 minutes in ms
const RECOVERY_PER_MS = BURST / WINDOW; // ~0.167 bytes/ms

describe("BudgetTracker", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("starts with full balance", () => {
    const bt = new BudgetTracker({ burstAmount: BURST, burstWindowMs: WINDOW });
    expect(bt.getAvailableBalance()).toBe(BURST);
  });

  it("starts with custom initial balance", () => {
    const bt = new BudgetTracker({
      burstAmount: BURST,
      burstWindowMs: WINDOW,
      initialBalance: 50_000,
    });
    expect(bt.getAvailableBalance()).toBe(50_000);
  });

  it("reduces balance after submission", () => {
    const bt = new BudgetTracker({ burstAmount: BURST, burstWindowMs: WINDOW });
    bt.recordSubmission(10_000);
    expect(bt.getAvailableBalance()).toBeCloseTo(190_000, -1);
  });

  it("recovers balance over time", () => {
    const bt = new BudgetTracker({ burstAmount: BURST, burstWindowMs: WINDOW });
    bt.recordSubmission(100_000);
    // Advance 10 minutes (half the window)
    jest.advanceTimersByTime(600_000);
    // Should recover ~100KB (half of burst)
    expect(bt.getAvailableBalance()).toBeCloseTo(200_000, -2);
  });

  it("caps recovery at burstAmount", () => {
    const bt = new BudgetTracker({ burstAmount: BURST, burstWindowMs: WINDOW });
    bt.recordSubmission(10_000);
    // Advance full window — should be back to max
    jest.advanceTimersByTime(WINDOW);
    expect(bt.getAvailableBalance()).toBe(BURST);
  });

  it("canSubmit respects safety margin", () => {
    const bt = new BudgetTracker({
      burstAmount: BURST,
      burstWindowMs: WINDOW,
      safetyMargin: 0.1,
    });
    // Effective budget = 180_000. Full balance = 200_000.
    // canSubmit checks: balance >= bytes + (burstAmount - effectiveBudget)
    // With full balance: 200_000 >= 180_001 + 20_000 = false
    expect(bt.canSubmit(180_001)).toBe(false);
    expect(bt.canSubmit(180_000)).toBe(true);
  });

  it("estimateWaitMs returns correct wait time", () => {
    const bt = new BudgetTracker({
      burstAmount: BURST,
      burstWindowMs: WINDOW,
      safetyMargin: 0,
    });
    bt.recordSubmission(BURST); // deplete fully
    // Need 10KB — deficit = 10_000 bytes
    const wait = bt.estimateWaitMs(10_000);
    // wait = 10_000 / RECOVERY_PER_MS = 10_000 / (200_000/1_200_000) ≈ 60_000ms
    expect(wait).toBeCloseTo(60_000, -2);
  });

  it("estimateWaitMs returns 0 when budget allows", () => {
    const bt = new BudgetTracker({
      burstAmount: BURST,
      burstWindowMs: WINDOW,
      safetyMargin: 0,
    });
    expect(bt.estimateWaitMs(10_000)).toBe(0);
  });

  it("recalibrate adjusts balance on overestimate", () => {
    const bt = new BudgetTracker({
      burstAmount: BURST,
      burstWindowMs: WINDOW,
      safetyMargin: 0,
    });
    bt.recordSubmission(10_000); // estimated 10KB
    // Actual was only 5KB — give back the difference
    bt.recalibrateFromActual(10_000, 5_000);
    expect(bt.getAvailableBalance()).toBeCloseTo(195_000, -1);
  });

  it("recalibrate adjusts balance on underestimate", () => {
    const bt = new BudgetTracker({
      burstAmount: BURST,
      burstWindowMs: WINDOW,
      safetyMargin: 0,
    });
    bt.recordSubmission(5_000); // estimated 5KB
    // Actual was 10KB — deduct more
    bt.recalibrateFromActual(5_000, 10_000);
    expect(bt.getAvailableBalance()).toBeCloseTo(190_000, -1);
  });

  it("reset restores full balance", () => {
    const bt = new BudgetTracker({ burstAmount: BURST, burstWindowMs: WINDOW });
    bt.recordSubmission(BURST);
    bt.reset();
    expect(bt.getAvailableBalance()).toBe(BURST);
  });

  it("snapshot returns correct values", () => {
    const bt = new BudgetTracker({
      burstAmount: BURST,
      burstWindowMs: WINDOW,
      safetyMargin: 0.1,
    });
    bt.recordSubmission(100_000);
    const snap = bt.snapshot();
    expect(snap.burstAmount).toBe(BURST);
    expect(snap.effectiveBudget).toBe(180_000);
    expect(snap.safetyMargin).toBe(0.1);
    expect(snap.balance).toBeCloseTo(100_000, -2);
    expect(snap.utilization).toBeCloseTo(0.5, 1);
    expect(snap.recoveryRatePerMs).toBeCloseTo(RECOVERY_PER_MS, 4);
  });

  it("never goes below zero", () => {
    const bt = new BudgetTracker({ burstAmount: BURST, burstWindowMs: WINDOW });
    bt.recordSubmission(BURST + 50_000);
    expect(bt.getAvailableBalance()).toBe(0);
  });
});
