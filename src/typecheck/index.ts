import ts from "typescript";
import { GUEST_COMPILER_OPTIONS, makeHost } from "./host";
import { GUEST_GLOBALS } from "./vfs";

export interface TypecheckDiagnostic {
  code: number;
  message: string;
  /** 1-based; -1 when the diagnostic has no file/start (global/config diags). */
  line: number;
  /** 1-based; -1 when the diagnostic has no file/start. */
  column: number;
  file: string;
  category: string;
}

export interface TypecheckResult {
  ok: boolean;
  diagnostics: TypecheckDiagnostic[];
  ms: number;
}

// tsc-rs drop-in seam. tsc-rs ships native binaries only today (no WASM
// build), so it cannot run inside workerd; this interface is the documented
// boundary a future WASM tsc-rs build implements. The agent loop (Phase 4)
// and the /typecheck benchmark depend on `Typechecker`, never on tsc
// directly — swapping implementations changes nothing above this line.
export interface Typechecker {
  readonly id: string;
  check(files: Map<string, string>): Promise<TypecheckResult>;
}

// Boot-time identity assert (TYPE-01): an accidental upgrade to npm "latest"
// (native tsgo 7.x) must fail loudly here, not silently break in-isolate
// checking. Runs once, on the first getTypechecker() call.
function assertCompilerIdentity(): void {
  if (ts.version !== "6.0.3") {
    throw new Error(
      `FATAL: in-isolate typechecker requires exactly typescript@6.0.3 (pure-JS line); ` +
        `loaded "${ts.version}". npm "latest" (7.x) is the NATIVE tsgo build and cannot run in workerd.`,
    );
  }
  if (typeof ts.createProgram !== "function" || typeof ts.getPreEmitDiagnostics !== "function") {
    throw new Error("FATAL: typescript createProgram/getPreEmitDiagnostics missing — API shape changed");
  }
  if (typeof (globalThis as Record<string, unknown>).process !== "undefined") {
    throw new Error(
      "FATAL: process global present — no_nodejs_compat flags lost; isNodeLikeSystem() would take the Node branch",
    );
  }
}

function mapDiagnostic(d: ts.Diagnostic): TypecheckDiagnostic {
  const loc =
    d.file !== undefined && d.start !== undefined
      ? ts.getLineAndCharacterOfPosition(d.file, d.start) // 0-based
      : { line: -1, character: -1 }; // global/config diags carry no file/start
  return {
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    line: loc.line + 1,
    column: loc.character + 1,
    file: d.file?.fileName ?? "(program)",
    category: ts.DiagnosticCategory[d.category],
  };
}

function byLocation(a: TypecheckDiagnostic, b: TypecheckDiagnostic): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
}

export class TsTypechecker implements Typechecker {
  readonly id = "typescript@6.0.3 (in-isolate)";

  async check(files: Map<string, string>): Promise<TypecheckResult> {
    const host = makeHost(files);
    const t0 = performance.now();
    const program = ts.createProgram({
      rootNames: [GUEST_GLOBALS, ...files.keys()],
      options: GUEST_COMPILER_OPTIONS,
      host,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const ms = performance.now() - t0;
    const mapped = diagnostics.map(mapDiagnostic).sort(byLocation);
    return { ok: mapped.every((d) => d.category !== "Error"), diagnostics: mapped, ms };
  }
}

// Second implementation (TYPE-04 seam proof): same interface, no
// createProgram — transpiles each file, always reports ok. A future tsc-rs
// WASM build plugs in exactly like this class does.
export class TranspileOnlyTypechecker implements Typechecker {
  readonly id = "transpile-only (seam proof)";

  async check(files: Map<string, string>): Promise<TypecheckResult> {
    const t0 = performance.now();
    for (const text of files.values()) {
      ts.transpileModule(text, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, isolatedModules: true },
      });
    }
    return { ok: true, diagnostics: [], ms: performance.now() - t0 };
  }
}

export type TypecheckerKind = "ts" | "transpile-only";

export function createTypechecker(kind: TypecheckerKind = "ts"): Typechecker {
  return kind === "ts" ? new TsTypechecker() : new TranspileOnlyTypechecker();
}

// Lazy module-level singleton (CONTEXT decision): boot assert + construction
// on first call; lib parse happens inside the first real check.
// getTypecheckerIdentity() never triggers init, so /healthz stays fast and
// flips only after the checker is genuinely used.
let singleton: Typechecker | undefined;

export function getTypechecker(): Typechecker {
  if (singleton === undefined) {
    assertCompilerIdentity();
    singleton = new TsTypechecker();
  }
  return singleton;
}

export function getTypecheckerIdentity(): string {
  return singleton !== undefined ? `typescript@${ts.version} (in-isolate)` : "unloaded";
}
