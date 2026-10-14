import { describe, expect, it } from "vitest";
import {
  GuestFileError,
  assertValidGuestFile,
  canonicalGuestPath,
  isGuestSourcePath,
} from "../src/typecheck-wasm/guard";

// v5 H1 regression guards: the wasm checker seeds an explicit files list
// built from VALIDATED guest paths, so nested sources ("/dir/guest.ts")
// enter the project (the old include: ["*.ts"] silently skipped them) and
// non-source files never do. Pure-module spec — no wasm in the transport.

describe("guest path canonicalization", () => {
  it("roots bare names and leaves rooted names untouched", () => {
    expect(canonicalGuestPath("guest.ts")).toBe("/guest.ts");
    expect(canonicalGuestPath("/dir/guest.ts")).toBe("/dir/guest.ts");
    expect(canonicalGuestPath("dir/nested/deep.ts")).toBe("/dir/nested/deep.ts");
  });
});

describe("guest extension validation (H1)", () => {
  it("accepts .ts sources at any depth, including .d.ts declarations", () => {
    expect(assertValidGuestFile("guest.ts")).toBe("/guest.ts");
    expect(assertValidGuestFile("/dir/guest.ts")).toBe("/dir/guest.ts");
    expect(assertValidGuestFile("ambient.d.ts")).toBe("/ambient.d.ts");
  });

  it("rejects non-source extensions (the tsconfig.json overwrite class)", () => {
    expect(() => assertValidGuestFile("tsconfig.json")).toThrow(GuestFileError);
    expect(() => assertValidGuestFile("guest.txt")).toThrow(GuestFileError);
    expect(() => assertValidGuestFile("guest.tsx")).toThrow(GuestFileError);
    expect(() => assertValidGuestFile("guest")).toThrow(GuestFileError);
    expect(() => assertValidGuestFile("dir/config.js")).toThrow(GuestFileError);
  });

  it("keys the verdict on the canonical (rooted) form", () => {
    expect(isGuestSourcePath(canonicalGuestPath("guest.ts"))).toBe(true);
    expect(isGuestSourcePath(canonicalGuestPath("tsconfig.json"))).toBe(false);
  });

  it("error messages name the offending canonical path", () => {
    try {
      assertValidGuestFile("evil.json");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("/evil.json");
    }
  });
});
