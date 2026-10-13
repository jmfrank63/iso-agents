// TscRsWasmTypechecker (WASM-02/03): the real Rust checker (ts_goport built
// to wasm32-wasip1) running INSIDE the workerd isolate behind the same
// Typechecker seam as TsTypechecker. One WebAssembly.Instance per check
// (the module's one-run-per-instance design; 2-8 ms instantiate — 06-
// RESEARCH), the libs are embedded in the module, and guest files ride the
// shim's in-memory fs bridge. Diagnostics arrive as ts_goport JSON and are
// mapped by ./mapping onto the exact flat shape the ts-js checker emits.
import { GUEST_GLOBALS_TEXT } from "../typecheck/vfs";
import type { TypecheckResult, Typechecker } from "../typecheck/index";
import { mapWasmDiagnostics } from "./mapping";
import { runTsc, TS_RUST_PIN } from "./shim";

// The spike-proven project config seeded into every check (06-RESEARCH
// probe requests): strict + es2022, wildcard include relative to /app.
// CLI args add --noEmit; everything else is the module's embedded default.
const TSCONFIG_TEXT = '{"compilerOptions":{"strict":true,"target":"es2022"},"include":["*.ts"]}';

export class TscRsWasmTypechecker implements Typechecker {
  readonly id = `ts-rust@${TS_RUST_PIN} (wasm)`;

  async check(files: Map<string, string>): Promise<TypecheckResult> {
    // Repo paths are rooted ("/guest.ts"); the module's project root is
    // /app (the tsconfig home) — guests are seeded one level down and
    // diagnostics are mapped back (mapping.ts) so reported files stay
    // byte-identical across checker implementations.
    const wasmFiles = new Map<string, string>([["/app/tsconfig.json", TSCONFIG_TEXT]]);
    for (const [name, content] of files) {
      wasmFiles.set(`/app${name.startsWith("/") ? name : `/${name}`}`, content);
    }
    // Ambient globals (test/expect/assert/console): include ["*.ts"] picks
    // the .d.ts up; without this seed every test() guest drowns in TS2593
    // (same rootName lesson as the ts-js checker and the 05-01 bench).
    wasmFiles.set("/app/guest-globals.d.ts", GUEST_GLOBALS_TEXT);
    const t0 = performance.now();
    const run = runTsc({
      files: wasmFiles,
      args: ["-p", "/app", "--noEmit"],
      cwd: "/",
      env: { NO_COLOR: "1" },
      diagnosticsJson: true,
    });
    const ms = performance.now() - t0;
    const diagnostics = mapWasmDiagnostics(run.diagnostics);
    return { ok: diagnostics.every((d) => d.category !== "Error"), diagnostics, ms };
  }
}
