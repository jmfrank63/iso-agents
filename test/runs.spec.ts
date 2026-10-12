import { MAX_STORED_RUNS, runRegistry } from "../src/runs";
import { describe, expect, it } from "vitest";

describe("runRegistry", () => {
  it("creates a record with uuid id, running status, task, and empty transcript", () => {
    const run = runRegistry.create("probe task");
    expect(typeof run.id).toBe("string");
    expect(run.id.length).toBe(36);
    expect(run.status).toBe("running");
    expect(run.task).toBe("probe task");
    expect(run.finishedAt).toBeNull();
    expect(run.iterations).toEqual([]);
    expect(run.timings).toBeNull();
    expect(() => new Date(run.createdAt).toISOString()).not.toThrow();
    expect(runRegistry.get(run.id)).toEqual(run);
  });

  it("returns undefined for an unknown id", () => {
    expect(runRegistry.get("nope")).toBeUndefined();
  });

  it("finalize stamps status, transcript, timings, and finishedAt", () => {
    const run = runRegistry.create("finalized task");
    const iterations = [
      {
        n: 1,
        llmMs: 1,
        explanation: "x",
        files: { "guest.ts": "1" },
        typecheck: null,
        transpileMs: null,
        sandbox: null,
        feedback: "fb",
      },
    ];
    const timings = { llmMs: 1, typecheckMs: 2, transpileMs: 3, sandboxMs: 4, totalMs: 5 };
    runRegistry.finalize(run.id, "max_iterations", iterations, timings);
    const stored = runRegistry.get(run.id);
    expect(stored?.status).toBe("max_iterations");
    expect(stored?.iterations).toEqual(iterations);
    expect(stored?.timings).toEqual(timings);
    expect(stored?.finishedAt).not.toBeNull();
  });

  it("caps the store at MAX_STORED_RUNS with FIFO eviction", () => {
    // Insert-count math keeps this independent of earlier tests in the file:
    // 51 fresh inserts always evict at least the first of them, whatever the
    // pre-existing size P (evictions = P + 2, oldest globally first).
    const first = runRegistry.create("will be evicted");
    for (let i = 0; i < MAX_STORED_RUNS; i++) {
      runRegistry.create("filler");
    }
    expect(runRegistry.get(first.id)).toBeUndefined();
    const fresh = runRegistry.create("the newest");
    expect(runRegistry.get(fresh.id)).toBeDefined();
  });
});
