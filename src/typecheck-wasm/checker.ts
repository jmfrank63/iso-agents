// TscRsWasmTypechecker (WASM-02/03 + FORK-02): the real Rust checker
// (ts_goport built to wasm32-wasip1, the multi-run fork) running INSIDE the
// workerd isolate behind the same Typechecker seam as TsTypechecker. ONE
// held WebAssembly.Instance per isolate — instance-per-isolate, not
// per-check — recycled after 50 runs (or the TSCHECKER_WASM_RECYCLE_AFTER
// override) and on any error, per 07-CONTEXT. The libs are embedded in the
// module; guest files ride the shim's held fs bridge, where every changed
// file is re-stamped so the fork's parse cache reuses exactly the unchanged
// files (07-RESEARCH: warm 71-123 ms vs ~0.5-1.2 s cold; memory flat at
// 62,521,344 bytes across runs 2-50). Diagnostics arrive as ts_goport JSON
// and are mapped by ./mapping onto the exact flat shape the ts-js checker
// emits.
import { GUEST_GLOBALS_TEXT } from "../typecheck/vfs";
import type {
  TypecheckerHeldStats,
  TypecheckResult,
  Typechecker,
} from "../typecheck/index";
import { mapWasmDiagnostics } from "./mapping";
import {
  heldRunStats,
  runTscHeld,
  TS_RUST_FORK_BRANCH,
  TS_RUST_FORK_COMMIT,
} from "./shim";

// The spike-proven project config seeded into every check (06-RESEARCH
// probe requests): strict + es2022, wildcard include relative to /app.
// CLI args add --noEmit; everything else is the module's embedded default.
// `lib: ["es2022"]` mirrors the ts-js guest surface (core closure, no DOM):
// the module's default lib chain includes DOM (`var console: Console`),
// which TS2403-clashes with the seeded guest-globals.d.ts console (proven
// live, 06-02 T2). Constant across every check — tsconfig and globals are
// parse-reused by the held instance forever.
const TSCONFIG_TEXT =
  '{"compilerOptions":{"strict":true,"target":"es2022","lib":["es2022"]},"include":["*.ts"]}';

export class TscRsWasmTypechecker implements Typechecker {
  // Fork-qualified identity (FORK-01): the fork changes observable
  // behavior (one instance, many runs), so the id says so.
  readonly id = `ts-rust@${TS_RUST_FORK_BRANCH}/${TS_RUST_FORK_COMMIT.slice(0, 7)} (wasm)`;

  // Undefined -> the shim's default (RECYCLE_AFTER_RUNS = 50). The factory
  // passes the parsed TSCHECKER_WASM_RECYCLE_AFTER so the live harness can
  // force the recycle boundary over HTTP.
  constructor(private readonly recycleAfter?: number) {}

  async check(files: Map<string, string>): Promise<TypecheckResult> {
    // Repo paths are rooted ("/guest.ts"); the module's project root is
    // /app (the tsconfig home) — guests are synced one level down and
    // diagnostics are mapped back (mapping.ts) so reported files stay
    // byte-identical across checker implementations. syncHeldFiles re-
    // stamps changed files and REMOVES files this check no longer has.
    const wasmFiles = new Map<string, string>([["/app/tsconfig.json", TSCONFIG_TEXT]]);
    for (const [name, content] of files) {
      wasmFiles.set(`/app${name.startsWith("/") ? name : `/${name}`}`, content);
    }
    // Ambient globals (test/expect/assert/console): include ["*.ts"] picks
    // the .d.ts up; without this seed every test() guest drowns in TS2593
    // (same rootName lesson as the ts-js checker and the 05-01 bench).
    wasmFiles.set("/app/guest-globals.d.ts", GUEST_GLOBALS_TEXT);
    const t0 = performance.now();
    const run = runTscHeld(
      {
        files: wasmFiles,
        args: ["-p", "/app", "--noEmit"],
        cwd: "/", // first-cwd freeze: run 1's cwd is every run's cwd (07-RESEARCH)
        env: { NO_COLOR: "1" },
        diagnosticsJson: true,
      },
      this.recycleAfter,
    );
    const ms = performance.now() - t0;
    const diagnostics = mapWasmDiagnostics(run.diagnostics);
    return { ok: diagnostics.every((d) => d.category !== "Error"), diagnostics, ms };
  }

  // FORK-03 observability: instance generation, run counters, recycle
  // count and the held instance's linear-memory bytes — the /typecheck
  // endpoint surfaces this so the live harness proves reuse + recycling
  // over HTTP without touching check()'s semantics.
  heldStats(): TypecheckerHeldStats {
    return heldRunStats();
  }
}
