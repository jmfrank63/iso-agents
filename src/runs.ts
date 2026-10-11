export type RunStatus = "running" | "success" | "max_iterations" | "deadline" | "llm_error";

export interface RunRecord {
  id: string;
  status: RunStatus;
  createdAt: string;
}

const runs = new Map<string, RunRecord>();

export const runRegistry = {
  create(): RunRecord {
    const run: RunRecord = { id: crypto.randomUUID(), status: "running", createdAt: new Date().toISOString() };
    runs.set(run.id, run);
    return run;
  },
  get(id: string): RunRecord | undefined {
    return runs.get(id);
  },
};
