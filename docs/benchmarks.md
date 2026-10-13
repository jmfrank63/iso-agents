# Benchmark: native tsc-rs vs the in-isolate checkers (ts-js + tsc-rs-wasm)

Reproduce with `npm run bench:tsc-rs` — it boots TWO `wrangler dev` workers (default ts-js +
TSCHECKER=tsc-rs-wasm), prints this table, and rewrites this file. README.md commits the same
numbers.

Generated: 2026-10-13T15:36:39.961Z

| snippet          | tsc-rs cold ms | tsc-rs warm med(10) | tsc-rs warm min | ts-js cold ms | ts-js warm med(5) | wasm cold ms | wasm warm med(5) | errors (exp/got) |
|------------------|----------------|---------------------|-----------------|---------------|-------------------|--------------|------------------|------------------|
| slugify-iter1    | 38.9 | 30.7 | 28.4 | 222.0 | 7.0 | 549.0 | 180.0 | 2/2 |
| slugify-final    | 36.2 | 30.4 | 29.6 | 7.0 | 5.0 | 160.0 | 156.0 | 0/0 |
| fibonacci-final  | 34.4 | 29.5 | 28.2 | 13.0 | 6.0 | 164.0 | 147.0 | 0/0 |
| lib-heavy        | 34.0 | 30.7 | 29.3 | 31.0 | 11.0 | 147.0 | 148.0 | 0/0 |
| synthetic-100    | 33.8 | 29.5 | 28.3 | 22.0 | 13.0 | 160.0 | 143.0 | 0/0 |

tsc-rs native spawn+init: 2.8 ms median across the 5 API instances (not part of the cold column).
Machine: linux arm64, v24.19.0, tsc-rs 0.2.0 (native), workerd via wrangler dev, typescript 6.0.3 in-isolate (ts-js), ts-rust wasm pin 569df52 in-isolate (TSCHECKER=tsc-rs-wasm).

Footnotes:
- tsc-rs warm med(10) = median of 10 subsequent createProgram+diagnostics checks on the SAME API instance (persistent native subprocess, sync-RPC); cold = the first such check after spawn.
- In-isolate cold = POST /typecheck data.coldMs (run 1 of 6); warm med(5) = median of runs 2-6 (runs: 6 so there are 5 warm samples; the endpoint default of 5 yields only 4).
- Lib-closure difference, footnoted rather than forced to parity: tsc-rs checks against its default lib.es2022.full chain INCLUDING DOM; the in-isolate checker uses the bundled 115-file es2022 core closure (no DOM). All five snippets type-check identically on both.
- Both legs share the guest surface: /guest-globals.d.ts (repo GUEST_GLOBALS_TEXT) is an explicit rootName on the tsc-rs leg and prepended implicitly by the in-isolate checker; options mirror GUEST_COMPILER_OPTIONS (strict, ES2022, noEmit, ESNext modules, Bundler resolution, skipLibCheck, isolatedModules, forceConsistentCasingInFileNames).
- tsc-rs is host-side only on the native leg (binary subprocess). Its WASM build is the third leg: the vendored ts_rust.wasm (unpublished; built from source at pin 569df52 — docs/ts-rust-wasm.md) runs INSIDE the isolate behind the same Typechecker interface.
- wasm cold ms / wasm warm med(5) = POST /typecheck against a SECOND wrangler dev boot with TSCHECKER=tsc-rs-wasm (runs: 6 — same 1 cold + 5 warm protocol as the ts-js leg). Every run builds a fresh WebAssembly.Instance (2-8 ms); the lib.d.ts closure is embedded in the module (strict + es2022 tsconfig under /app, mirroring the ts-js guest surface).
- The wasm module ships unconditionally in the worker bundle (+5,125,434 bytes raw); local dev does not enforce CPU limits — a wasm check costs ~0.6-1.2 s of synchronous CPU per run.
