import { describe, expect, it } from "vitest";
import { ASYNC_SOURCE_PATTERN, findAsyncUsage } from "../src/sandbox/gate";
import { HARNESS_SOURCE } from "../src/sandbox/harness";
import { SANDBOX_IDENTITY, getSandboxIdentity, markSandboxLoaded } from "../src/sandbox/identity";
import {
  DEFAULT_MEMORY_LIMIT_MB,
  DEFAULT_STACK_KB,
  DEFAULT_TIMEOUT_MS,
  MAX_GUEST_SOURCE_BYTES,
  MAX_STACK_KB,
  parseLimits,
} from "../src/sandbox/limits";

// Pure sandbox pieces ONLY: this spec must never import src/sandbox/runtime.ts
// (its module graph pulls quickjs-emscripten-core into the vitest worker
// transport — the Phase 2 lesson). Runtime behavior is proven by
// scripts/test-sandbox-live.mjs (03-02) against real workerd.

describe("sandbox limits", () => {
  it("defaults: 2000ms timeout, 64MiB memory, 64KiB stack", () => {
    const limits = parseLimits({});
    expect(limits.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(limits.timeoutMs).toBe(2000);
    expect(limits.memoryLimitBytes).toBe(DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024);
    expect(limits.memoryLimitBytes).toBe(67108864);
    expect(limits.stackBytes).toBe(DEFAULT_STACK_KB * 1024);
    expect(limits.stackBytes).toBe(65536);
  });

  it("env overrides parse; stack hard-caps at 128KiB", () => {
    const limits = parseLimits({
      SANDBOX_TIMEOUT_MS: "500",
      SANDBOX_MEMORY_LIMIT_MB: "32",
      SANDBOX_STACK_KB: "512",
    });
    expect(limits.timeoutMs).toBe(500);
    expect(limits.memoryLimitBytes).toBe(32 * 1024 * 1024);
    expect(limits.stackBytes).toBe(MAX_STACK_KB * 1024);
    expect(limits.stackBytes).toBe(131072);
  });

  it("garbage env values fall back to defaults", () => {
    const limits = parseLimits({
      SANDBOX_TIMEOUT_MS: "abc",
      SANDBOX_MEMORY_LIMIT_MB: "-4",
      SANDBOX_STACK_KB: "0",
    });
    expect(limits.timeoutMs).toBe(2000);
    expect(limits.memoryLimitBytes).toBe(64 * 1024 * 1024);
    expect(limits.stackBytes).toBe(64 * 1024);
  });
});

describe("async source gate", () => {
  it("flags async, await, and Promise tokens", () => {
    expect(findAsyncUsage("async function f() {}")).toBe("async");
    expect(findAsyncUsage("await Promise.resolve()")).toBe("await");
    expect(findAsyncUsage("new Promise(function (resolve) { resolve(1); })")).toBe("Promise");
    expect(ASYNC_SOURCE_PATTERN.test("function f() { return 1; }")).toBe(false);
  });

  it("word boundaries: identifiers containing the tokens are not flagged", () => {
    expect(findAsyncUsage("const myPromiseValue = 1;")).toBe(null);
    expect(findAsyncUsage("unawaited = 1;")).toBe(null);
  });

  it("guest source cap is 20480 bytes", () => {
    expect(MAX_GUEST_SOURCE_BYTES).toBe(20480);
  });
});

describe("guest harness source", () => {
  it("defines test(), chainable expect(), and assert()", () => {
    expect(HARNESS_SOURCE.includes("globalThis.test =")).toBe(true);
    expect(HARNESS_SOURCE.includes("toEqual:")).toBe(true);
    expect(HARNESS_SOURCE.includes("toBeTrue:")).toBe(true);
    expect(HARNESS_SOURCE.includes("toBeCloseTo:")).toBe(true);
    expect(HARNESS_SOURCE.includes("globalThis.assert =")).toBe(true);
  });

  it("harness source is itself sync-only (passes the gate)", () => {
    expect(findAsyncUsage(HARNESS_SOURCE)).toBe(null);
  });
});

describe("sandbox identity", () => {
  it("reports unloaded before the first execution", () => {
    expect(getSandboxIdentity()).toBe("unloaded");
  });

  it("flips to the variant identity once the module has loaded", () => {
    markSandboxLoaded();
    expect(getSandboxIdentity()).toBe(SANDBOX_IDENTITY);
    expect(getSandboxIdentity()).toBe("quickjs-wasmfile-release-sync@0.32.0");
  });
});
