import { describe, expect, it } from "vitest";
import {
  mapWasmDiagnostic,
  mapWasmDiagnostics,
  type WasmDiagnostic,
} from "../src/typecheck-wasm/mapping";
import { createMemoryFileSystem } from "../src/typecheck-wasm/memfs";

// Pure-mapping coverage for the tsc-rs-wasm checker (small-module
// discipline — mapping.ts and memfs.ts have zero runtime imports, so this
// spec never drags the 5.1 MB wasm module or the 8.8 MB typescript build
// into the vitest transport; the Phase 2 lesson). The real checker's
// in-workerd behavior is proven by scripts/test-typecheck-wasm-live.mjs
// (plan 06-02).

// The TS2322 shape the spike probe returned for `const n: number = 'one'`
// at /app/guest.ts (06-RESEARCH): startPosition is ZERO-based, category
// 1 = Error.
const TS2322: WasmDiagnostic = {
  fileName: "/app/guest.ts",
  startPosition: { line: 0, character: 6 },
  code: 2322,
  category: 1,
  text: "Type 'string' is not assignable to type 'number'.",
};

describe("wasm diagnostic mapping", () => {
  it("maps the probe's TS2322 to the flat 1-based repo shape at 1:7 /guest.ts", () => {
    expect(mapWasmDiagnostic(TS2322)).toEqual({
      code: 2322,
      message: "Type 'string' is not assignable to type 'number'.",
      line: 1,
      column: 7,
      file: "/guest.ts",
      category: "Error",
    });
  });

  it("maps slugify-style line-2 diagnostics to 2:9", () => {
    const mapped = mapWasmDiagnostic({
      fileName: "/app/guest.ts",
      startPosition: { line: 1, character: 8 },
      code: 2322,
      category: 1,
      text: "Type 'number' is not assignable to type 'string'.",
    });
    expect(mapped.line).toBe(2);
    expect(mapped.column).toBe(9);
    expect(mapped.file).toBe("/guest.ts");
  });

  it("maps config diagnostics (no startPosition/fileName) to the (program) -1/-1 shape", () => {
    expect(mapWasmDiagnostic({ code: 5103, category: 1, text: "Unknown option." })).toEqual({
      code: 5103,
      message: "Unknown option.",
      line: -1,
      column: -1,
      file: "(program)",
      category: "Error",
    });
  });

  it("maps every tsc category number to the ts.DiagnosticCategory name (unknown -> string)", () => {
    expect(mapWasmDiagnostic({ ...TS2322, category: 0 }).category).toBe("Warning");
    expect(mapWasmDiagnostic({ ...TS2322, category: 1 }).category).toBe("Error");
    expect(mapWasmDiagnostic({ ...TS2322, category: 2 }).category).toBe("Message");
    expect(mapWasmDiagnostic({ ...TS2322, category: 3 }).category).toBe("Suggestion");
    expect(mapWasmDiagnostic({ ...TS2322, category: 9 }).category).toBe("9");
  });

  it("sorts mapped diagnostics by file, then line, then column", () => {
    const sorted = mapWasmDiagnostics([
      { ...TS2322, startPosition: { line: 1, character: 0 } },
      { ...TS2322, fileName: "/app/a.ts", startPosition: { line: 0, character: 30 } },
      { ...TS2322, startPosition: { line: 0, character: 2 } },
      { code: 5103, category: 1, text: "config" },
    ]);
    expect(sorted.map((d) => `${d.file}:${d.line}:${d.column}`)).toEqual([
      "(program):-1:-1",
      "/a.ts:1:31",
      "/guest.ts:1:3",
      "/guest.ts:2:1",
    ]);
  });
});

describe("wasm memory filesystem", () => {
  const seed = (): Map<string, string> =>
    new Map([
      ["/app/index.ts", "export const a = 1;\n"],
      ["/app/util/helpers.ts", "export const b = 2;\n"],
    ]);

  it("reads seeded files and returns undefined for misses", () => {
    const fs = createMemoryFileSystem(seed());
    expect(fs.readFile("/app/index.ts")).toBe("export const a = 1;\n");
    expect(fs.readFile("/app/nope.ts")).toBeUndefined();
  });

  it("stats files with byte sizes and synthesizes directory stats", () => {
    const fs = createMemoryFileSystem(seed());
    expect(fs.stat("/app/index.ts")).toEqual({ isDirectory: false, size: 20, mtimeMs: 0 });
    expect(fs.stat("/app")).toEqual({ isDirectory: true, size: 0, mtimeMs: 0 });
    expect(fs.stat("/")).toEqual({ isDirectory: true, size: 0, mtimeMs: 0 });
    expect(fs.stat("/app/nope.ts")).toBeUndefined();
  });

  it("lists immediate directory entries with file/directory kinds (undefined for misses)", () => {
    const fs = createMemoryFileSystem(seed());
    expect(fs.readDirectory("/app")).toEqual([
      { name: "index.ts", kind: "file" },
      { name: "util", kind: "directory" },
    ]);
    expect(fs.readDirectory("/nope")).toBeUndefined();
  });

  it("realpaths existing files and directories only", () => {
    const fs = createMemoryFileSystem(seed());
    expect(fs.realpath("/app/index.ts")).toBe("/app/index.ts");
    expect(fs.realpath("/app/util")).toBe("/app/util");
    expect(fs.realpath("/nope")).toBeUndefined();
  });

  it("writes and appends text, rejecting paths under an existing file", () => {
    const fs = createMemoryFileSystem(seed());
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(fs.writeFile("/app/out.js", bytes("emit;\n"), false)).toBeUndefined();
    expect(fs.readFile("/app/out.js")).toBe("emit;\n");
    expect(fs.writeFile("/app/out.js", bytes("more;\n"), true)).toBeUndefined();
    expect(fs.readFile("/app/out.js")).toBe("emit;\nmore;\n");
    expect(fs.writeFile("/app/index.ts/nested.js", bytes("x"), false)).toBe(
      "mkdir /app/index.ts: not a directory",
    );
  });

  it("removes files and directory subtrees", () => {
    const fs = createMemoryFileSystem(seed());
    fs.remove("/app/util");
    expect(fs.readFile("/app/util/helpers.ts")).toBeUndefined();
    fs.remove("/app/index.ts");
    expect(fs.readFile("/app/index.ts")).toBeUndefined();
    expect(fs.readDirectory("/app")).toBeUndefined();
  });
});
