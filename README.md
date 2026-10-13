# iso-agents

A prototype of an AI coding agent that lives entirely inside a Cloudflare workerd isolate:
given a small coding task and a spec, it generates TypeScript, type-checks it in-isolate,
executes it in a WASM sandbox, reads the diagnostics, and iterates until the code is green
— all within a single request. See AGENTS.md for project context and stack decisions.

## Why this exists

The tsc-rs video thesis: an agent's write → check → run → fix loop only becomes viable inside
a request-scoped runtime when type-checking is fast enough to run many times per request.
This repo maps that stack onto a workerd isolate — and is honest about where each piece runs
today:

| Piece            | The video's stack                          | This repo                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type-checker     | tsc-rs (native TS7-port lineage)           | **Both sides now.** Native host-side for the bench's first leg — and INSIDE the isolate: ts-rust built from source at pin 569df52, vendored as `src/typecheck-wasm/ts_rust.wasm` (unpublished; built from source at pin 569df52 — nothing is on npm). Selected with `TSCHECKER=tsc-rs-wasm`, default `ts-js`. |
| Drop-in seam     | swap the compiler in                       | The `Typechecker` interface (src/typecheck/index.ts) — the agent loop, `/agent/shell` and `/typecheck` depend on the interface, never on a concrete checker; the WASM build plugged in exactly this way (`TscRsWasmTypechecker` via `TSCHECKER=tsc-rs-wasm`), as did `TranspileOnlyTypechecker`. |
| In-isolate check | —                                          | `TSCHECKER` selects: `ts-js` (default) = pure-JS `typescript@6.0.3` with a fully in-memory CompilerHost (bundled es2022 core lib closure, libs memoized per isolate, warm checks in single-digit-to-low ms); `tsc-rs-wasm` = the vendored Rust checker (embedded lib closure, fresh wasm instance per check). |
| Execution        | run the code                               | QuickJS-WASM **inside the same isolate** — counter+wall-clock deadline interrupt, memory/stack limits, fresh single-use context, captured console, and zero host eval (`npm run gate:no-host-eval`).                                             |
| Agent surface    | a shell on a box                           | `POST /agent/run` (the request-scoped loop) and `POST /agent/shell` (a stateless tool-protocol session, below) — the operational surface an external agent harness drives over HTTP.                                                             |

## Benchmark

Measured, not asserted. Reproduce with `npm run bench:tsc-rs` — it checks the same five guest
snippets with the native tsc-rs binary (host-side JS API, cold + 10 warm runs) and BOTH
in-isolate checkers (two booted `wrangler dev` workers: default ts-js, then
`--var TSCHECKER:tsc-rs-wasm`; POST /typecheck, runs: 6 → 1 cold + 5 warm each), writes
[docs/benchmarks.md](docs/benchmarks.md), and prints exactly this table:

<!-- BEGIN BENCH TABLE — paste the exact table + spawn line + machine line + footnotes
     emitted by scripts/bench-tsc-rs.mjs between these markers. Real numbers from a real
     run only; never hand-edit. -->

| snippet          | tsc-rs cold ms | tsc-rs warm med(10) | tsc-rs warm min | ts-js cold ms | ts-js warm med(5) | wasm cold ms | wasm warm med(5) | errors (exp/got) |
|------------------|----------------|---------------------|-----------------|---------------|-------------------|--------------|------------------|------------------|
| slugify-iter1    | 41.3 | 30.2 | 28.9 | 236.0 | 8.0 | 543.0 | 177.0 | 2/2 |
| slugify-final    | 33.5 | 30.3 | 29.6 | 7.0 | 5.0 | 159.0 | 148.0 | 0/0 |
| fibonacci-final  | 39.8 | 30.2 | 28.1 | 11.0 | 5.0 | 160.0 | 145.0 | 0/0 |
| lib-heavy        | 33.2 | 31.7 | 30.0 | 30.0 | 12.0 | 148.0 | 145.0 | 0/0 |
| synthetic-100    | 31.8 | 29.7 | 28.8 | 19.0 | 12.0 | 162.0 | 147.0 | 0/0 |

tsc-rs native spawn+init: 2.6 ms median across the 5 API instances (not part of the cold column).
Machine: linux arm64, v24.19.0, tsc-rs 0.2.0 (native), workerd via wrangler dev, typescript 6.0.3 in-isolate (ts-js), ts-rust wasm pin 569df52 in-isolate (TSCHECKER=tsc-rs-wasm).

Footnotes:
- tsc-rs warm med(10) = median of 10 subsequent createProgram+diagnostics checks on the SAME API instance (persistent native subprocess, sync-RPC); cold = the first such check after spawn.
- In-isolate cold = POST /typecheck data.coldMs (run 1 of 6); warm med(5) = median of runs 2-6 (runs: 6 so there are 5 warm samples; the endpoint default of 5 yields only 4).
- Lib-closure difference, footnoted rather than forced to parity: tsc-rs checks against its default lib.es2022.full chain INCLUDING DOM; the in-isolate checker uses the bundled 115-file es2022 core closure (no DOM). All five snippets type-check identically on both.
- Both legs share the guest surface: /guest-globals.d.ts (repo GUEST_GLOBALS_TEXT) is an explicit rootName on the tsc-rs leg and prepended implicitly by the in-isolate checker; options mirror GUEST_COMPILER_OPTIONS (strict, ES2022, noEmit, ESNext modules, Bundler resolution, skipLibCheck, isolatedModules, forceConsistentCasingInFileNames).
- tsc-rs is host-side only on the native leg (binary subprocess). Its WASM build is the third leg: the vendored ts_rust.wasm (unpublished; built from source at pin 569df52 — docs/ts-rust-wasm.md) runs INSIDE the isolate behind the same Typechecker interface.
- wasm cold ms / wasm warm med(5) = POST /typecheck against a SECOND wrangler dev boot with TSCHECKER=tsc-rs-wasm (runs: 6 — same 1 cold + 5 warm protocol as the ts-js leg). Every run builds a fresh WebAssembly.Instance (2-8 ms); the lib.d.ts closure is embedded in the module (strict + es2022 tsconfig under /app, mirroring the ts-js guest surface).
- The wasm module ships unconditionally in the worker bundle (+5,125,434 bytes raw); local dev does not enforce CPU limits — a wasm check costs ~0.6-1.2 s of synchronous CPU per run.

<!-- END BENCH TABLE -->

Honest reading (measured on this machine): warm-for-warm on these tiny (~350-byte) guests the
ts-js checker stays competitive with native tsc-rs; the wasm checker pays a much larger
per-check CPU cost for the real Rust compiler INSIDE the isolate — the video's stack story,
now executed where the loop runs. Build provenance and rebuild steps:
[docs/ts-rust-wasm.md](docs/ts-rust-wasm.md).

## Running agents on this isolate

Every endpoint speaks one JSON envelope: `{"ok": true, "data": …}` or
`{"ok": false, "error": {"code", "message", "detail?"}}`. No auth, no API keys; all state is
in-memory and dies with the isolate.

| Endpoint          | Method | Body                                            | Returns                                                                                                                              |
| ----------------- | ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/healthz`        | GET    | —                                               | runtime identity: workerd, compatibility date, typechecker/sandbox load state (reflects the `TSCHECKER` selection), agent provider, isolate `instanceId` |
| `/agent/run`      | POST   | `{task, spec, maxIterations?}`                  | the full run: iterations (LLM output, files, diagnostics, sandbox results, feedback), per-step timings, terminal status                 |
| `/agent/run/:id`  | GET    | —                                               | the stored run (honest 404 for unknown ids — in-memory store)                                                                          |
| `/agent/shell`    | POST   | `{commands: [{op, args}...], files?, stopOnError?}` | per-op results `[{op, ok, result, ms}]` (+ `haltedAt` when `stopOnError` halted); ops: `ls`/`cat`/`write`/`rm`/`typecheck`/`run` over a per-request VFS (lands with plan 05-02) |
| `/typecheck`      | POST   | `{files: {name: content}, runs?}`               | N-run latency stats `{runs, results, minMs, medianMs, meanMs, coldMs}` — the benchmark hook above                                      |
| `/sandbox/execute`| POST   | `{code}`                                        | structured `ExecuteResult` `{status, logs, tests, result?, error?, ms}` (200 even when the guest timed out — the execution succeeded)   |

## Commands

- `npm run dev` — start `wrangler dev` (real workerd, local, no Cloudflare account) on http://localhost:8787
- `npm run check` — strict type-check (`tsc --noEmit`)
- `npm test` — vitest run (small-module specs only; worker-graph behavior lives in the live harnesses)
- `npm run test:live` — the live harnesses under real workerd (typecheck ts-js, sandbox, agent loop, agent shell, typecheck tsc-rs-wasm)
- `npm run bench:tsc-rs` — the benchmark table above (boots TWO `wrangler dev` workers: ts-js + TSCHECKER=tsc-rs-wasm)
- `npm run bundle:check` — dry-run production bundle gate (no upload)
- `npm run gate:no-host-eval` — grep gate: no `eval`/`new Function` in src/ (QuickJS-WASM is the only execution path)
- `TSCHECKER=ts-js|tsc-rs-wasm` — checker selection (default `ts-js`); under `wrangler dev`, pass it as `--var TSCHECKER:tsc-rs-wasm`. `/healthz` identity flips to `ts-rust@569df52 (wasm)` after the first check in wasm mode.

## Smoke test

```sh
npm run dev &
sleep 8
curl -s --max-time 5 http://localhost:8787/healthz
```

Returns the JSON envelope with the full runtime identity — `typechecker`/`sandbox` report
`"unloaded"` until the first real use (lazy singletons), and `workerd`/`userAgent` report
`navigator.userAgent` (best-effort: workerd has no in-band version API).
