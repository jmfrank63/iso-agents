import { runRegistry } from "../src/runs";
import { describe, expect, it } from "vitest";

describe("runRegistry", () => {
  it("creates a record with uuid id, running status, ISO timestamp", () => {
    const run = runRegistry.create();
    expect(typeof run.id).toBe("string");
    expect(run.id.length).toBe(36);
    expect(run.status).toBe("running");
    expect(() => new Date(run.createdAt).toISOString()).not.toThrow();
    expect(runRegistry.get(run.id)).toEqual(run);
  });

  it("returns undefined for an unknown id", () => {
    expect(runRegistry.get("nope")).toBeUndefined();
  });
});
