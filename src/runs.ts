// In-memory run registry (Phase 1 seam), grown in Phase 4 (OBS-02): records
// carry the full transcript + timings; terminal statuses are loop.ts's
// AgentStatus composed with "running" (CONTEXT locked set — ROADMAP's
// deadline name is renamed "run_deadline" and "llm_malformed" is added; G1).
// FIFO cap at 50 runs (Map insertion-order eviction; transcripts are a few
// hundred KB worst case -> low MB, safely inside the 128 MB isolate — G8).
import type { AgentIteration, AgentStatus, AgentTimings } from "./agent/loop";

export type RunStatus = "running" | AgentStatus;

export interface RunRecord {
  id: string;
  status: RunStatus;
  task: string;
  createdAt: string;
  finishedAt: string | null;
  iterations: AgentIteration[];
  timings: AgentTimings | null;
}

export const MAX_STORED_RUNS = 50;

const runs = new Map<string, RunRecord>();

export const runRegistry = {
  create(task: string): RunRecord {
    if (runs.size >= MAX_STORED_RUNS) {
      const oldest = runs.keys().next();
      if (oldest.done !== true) {
        runs.delete(oldest.value);
      }
    }
    const run: RunRecord = {
      id: crypto.randomUUID(),
      status: "running",
      task,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      iterations: [],
      timings: null,
    };
    runs.set(run.id, run);
    return run;
  },
  // Unchanged Phase 1 contract; the 404 route path rides on this.
  get(id: string): RunRecord | undefined {
    return runs.get(id);
  },
  // Mutates the stored record in place — the caller's `create` reference IS
  // the stored record, so the POST handler serializes it after finalize.
  // finishedAt uses wall-clock ISO time (transcript timing fidelity is
  // performance.now()'s job; this is registry bookkeeping).
  finalize(id: string, status: RunStatus, iterations: AgentIteration[], timings: AgentTimings | null): void {
    const run = runs.get(id);
    if (run === undefined) {
      return;
    }
    run.status = status;
    run.iterations = iterations;
    run.timings = timings;
    run.finishedAt = new Date().toISOString();
  },
};
