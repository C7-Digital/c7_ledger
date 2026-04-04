import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryTransactionLog,
  JsonlTransactionLog,
  type TransactionRecord,
} from "./transaction-log";

function makeRecord(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: `tx-${Math.random().toString(36).substring(2, 8)}`,
    commandId: `cmd-${Date.now()}`,
    state: "queued",
    retryCount: 0,
    enqueuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    priority: 0,
    ...overrides,
  };
}

describe("InMemoryTransactionLog", () => {
  it("records and retrieves by id", async () => {
    const log = new InMemoryTransactionLog();
    const rec = makeRecord({ id: "tx-1" });
    await log.record(rec);
    expect(await log.get("tx-1")).toEqual(rec);
  });

  it("returns undefined for unknown id", async () => {
    const log = new InMemoryTransactionLog();
    expect(await log.get("nope")).toBeUndefined();
  });

  it("filters by state", async () => {
    const log = new InMemoryTransactionLog();
    await log.record(makeRecord({ id: "a", state: "queued" }));
    await log.record(makeRecord({ id: "b", state: "submitting" }));
    await log.record(makeRecord({ id: "c", state: "queued" }));
    const queued = await log.getByState("queued");
    expect(queued.map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  it("updates existing record on re-record", async () => {
    const log = new InMemoryTransactionLog();
    const rec = makeRecord({ id: "tx-1", state: "queued" });
    await log.record(rec);
    await log.record({ ...rec, state: "completed" });
    const result = await log.get("tx-1");
    expect(result?.state).toBe("completed");
  });

  it("getAll returns all records", async () => {
    const log = new InMemoryTransactionLog();
    await log.record(makeRecord({ id: "a" }));
    await log.record(makeRecord({ id: "b" }));
    const all = await log.getAll();
    expect(all).toHaveLength(2);
  });

  it("returns copies, not references", async () => {
    const log = new InMemoryTransactionLog();
    const rec = makeRecord({ id: "tx-1" });
    await log.record(rec);
    const fetched = await log.get("tx-1");
    fetched!.state = "completed";
    const refetched = await log.get("tx-1");
    expect(refetched!.state).toBe("queued");
  });
});

describe("JsonlTransactionLog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "txlog-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("records and retrieves by id", async () => {
    const filePath = join(tmpDir, "test.jsonl");
    const log = new JsonlTransactionLog(filePath);
    const rec = makeRecord({ id: "tx-1" });
    await log.record(rec);
    expect(await log.get("tx-1")).toEqual(rec);
  });

  it("persists to file as JSONL", async () => {
    const filePath = join(tmpDir, "test.jsonl");
    const log = new JsonlTransactionLog(filePath);
    await log.record(makeRecord({ id: "tx-1", state: "queued" }));
    await log.record(makeRecord({ id: "tx-2", state: "submitting" }));

    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe("tx-1");
    expect(JSON.parse(lines[1]!).id).toBe("tx-2");
  });

  it("survives reload — last entry per id wins", async () => {
    const filePath = join(tmpDir, "test.jsonl");

    // Write with one instance
    const log1 = new JsonlTransactionLog(filePath);
    await log1.record(makeRecord({ id: "tx-1", state: "queued" }));
    await log1.record(makeRecord({ id: "tx-1", state: "completed" }));

    // Read with a fresh instance (simulates server restart)
    const log2 = new JsonlTransactionLog(filePath);
    const result = await log2.get("tx-1");
    expect(result?.state).toBe("completed");
  });

  it("finds transactions in submitting state for recovery", async () => {
    const filePath = join(tmpDir, "test.jsonl");
    const log1 = new JsonlTransactionLog(filePath);
    await log1.record(makeRecord({ id: "tx-1", state: "completed" }));
    await log1.record(makeRecord({ id: "tx-2", state: "submitting" }));
    await log1.record(makeRecord({ id: "tx-3", state: "prepared" }));

    // Fresh instance for recovery
    const log2 = new JsonlTransactionLog(filePath);
    const submitting = await log2.getByState("submitting");
    expect(submitting).toHaveLength(1);
    expect(submitting[0]!.id).toBe("tx-2");
  });

  it("handles nonexistent file gracefully", async () => {
    const filePath = join(tmpDir, "nonexistent.jsonl");
    const log = new JsonlTransactionLog(filePath);
    expect(await log.getAll()).toEqual([]);
  });

  it("skips malformed lines", async () => {
    const filePath = join(tmpDir, "test.jsonl");
    // Write valid and invalid lines manually
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      filePath,
      `${JSON.stringify(makeRecord({ id: "tx-1" }))}\ngarbage line\n${JSON.stringify(makeRecord({ id: "tx-2" }))}\n`,
    );

    const log = new JsonlTransactionLog(filePath);
    const all = await log.getAll();
    expect(all).toHaveLength(2);
  });
});
