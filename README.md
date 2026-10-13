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
| Type-checker     | tsc-rs (native TS7-port lineage)           | **Host-side today** (`scripts/bench-tsc-rs.mjs`, table below). Native binaries cannot execute inside workerd and no WASM build exists yet.                                                                                                      |
| Drop-in seam     | swap the compiler in                       | The `Typechecker` interface (src/typecheck/index.ts) — the agent loop and `/typecheck` depend on the interface, never on tsc directly; a future tsc-rs WASM build plugs in exactly the way `TranspileOnlyTypechecker` already does.              |
| In-isolate check | —                                          | pure-JS `typescript@6.0.3` with a fully in-memory CompilerHost: bundled es2022 core lib closure (no DOM, no `ts.sys`), libs memoized per isolate, warm checks in single-digit-to-low ms.                                                         |
| Execution        | run the code                               | QuickJS-WASM **inside the same isolate** — counter+wall-clock deadline interrupt, memory/stack limits, fresh single-use context, captured console, and zero host eval (`npm run gate:no-host-eval`).                                             |
| Agent surface    | a shell on a box                           | `POST /agent/run` (the request-scoped loop) and `POST /agent/shell` (a stateless tool-protocol session, below) — the operational surface an external agent harness drives over HTTP.                                                             |

## Benchmark

Measured, not asserted. Reproduce with `npm run bench:tsc-rs` — it checks the same five guest
snippets with the native tsc-rs binary (host-side JS API, cold + 10 warm runs) and the
in-isolate checker (booted `wrangler dev`, POST /typecheck, runs: 6 → 1 cold + 5 warm), writes
[docs/benchmarks.md](docs/benchmarks.md), and prints exactly this table:

<!-- BEGIN BENCH TABLE — paste the exact table + spawn line + machine line + footnotes
     emitted by scripts/bench-tsc-rs.mjs between these markers. Real numbers from a real
     run only; never hand-edit. -->

| snippet          | tsc-rs cold ms | tsc-rs warm med(10) | tsc-rs warm min | in-isolate cold ms | in-isolate warm med(5) | errors (exp/got) |
|------------------|----------------|---------------------|-----------------|--------------------|------------------------|------------------|
| slugify-iter1    | 40.0 | 33.8 | 31.6 | 242.0 | 8.0 | 2/2 |
| slugify-final    | 36.0 | 32.1 | 29.8 | 6.0 | 5.0 | 0/0 |
| fibonacci-final  | 35.7 | 32.1 | 30.0 | 12.0 | 6.0 | 0/0 |
| lib-heavy        | 36.1 | 31.6 | 30.4 | 35.0 | 13.0 | 0/0 |
| synthetic-100    | 42.2 | 31.6 | 30.6 | 23.0 | 14.0 | 0/0 |

tsc-rs native spawn+init: 2.5 ms median across the 5 API instances (not part of the cold column).
Machine: linux arm64, v24.19.0, tsc-rs 0.2.0 (native), workerd via wrangler dev, typescript 6.0.3 in-isolate.

Footnotes:
- tsc-rs warm med(10) = median of 10 subsequent createProgram+diagnostics checks on the SAME API instance (persistent native subprocess, sync-RPC); cold = the first such check after spawn.
- In-isolate cold = POST /typecheck data.coldMs (run 1 of 6); warm med(5) = median of runs 2-6 (runs: 6 so there are 5 warm samples; the endpoint default of 5 yields only 4).
- Lib-closure difference, footnoted rather than forced to parity: tsc-rs checks against its default lib.es2022.full chain INCLUDING DOM; the in-isolate checker uses the bundled 115-file es2022 core closure (no DOM). All five snippets type-check identically on both.
- Both legs share the guest surface: /guest-globals.d.ts (repo GUEST_GLOBALS_TEXT) is an explicit rootName on the tsc-rs leg and prepended implicitly by the in-isolate checker; options mirror GUEST_COMPILER_OPTIONS (strict, ES2022, noEmit, ESNext modules, Bundler resolution, skipLibCheck, isolatedModules, forceConsistentCasingInFileNames).
- tsc-rs is host-side only here (native binary subprocess, never bundleable into workerd). The Typechecker interface (src/typecheck/index.ts) stays the drop-in seam for a future WASM build.

<!-- END BENCH TABLE -->

Honest reading (measured on this machine): warm-for-warm on these tiny (~350-byte) guests, the
in-isolate memoized-lib checker stays competitive with native tsc-rs; tsc-rs's advantage is
cold/large-program checking — and its role here is the video's stack story plus the
`Typechecker` seam that makes the swap trivial when a WASM build lands.

## Running agents on this isolate

Every endpoint speaks one JSON envelope: `{"ok": true, "data": …}` or
`{"ok": false, "error": {"code", "message", "detail?"}}`. No auth, no API keys; all state is
in-memory and dies with the isolate.

| Endpoint          | Method | Body                                            | Returns                                                                                                                              |
| ----------------- | ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/healthz`        | GET    | —                                               | runtime identity: workerd, compatibility date, typechecker/sandbox load state, agent provider, isolate `instanceId`                    |
| `/agent/run`      | POST   | `{task, spec, maxIterations?}`                  | the full run: iterations (LLM output, files, diagnostics, sandbox results, feedback), per-step timings, terminal status                 |
| `/agent/run/:id`  | GET    | —                                               | the stored run (honest 404 for unknown ids — in-memory store)                                                                          |
| `/agent/shell`    | POST   | `{commands: [{op, args}...], files?, stopOnError?}` | per-op results `[{op, ok, result, ms}]` (+ `haltedAt` when `stopOnError` halted); ops: `ls`/`cat`/`write`/`rm`/`typecheck`/`run` over a per-request VFS (lands with plan 05-02) |
| `/typecheck`      | POST   | `{files: {name: content}, runs?}`               | N-run latency stats `{runs, results, minMs, medianMs, meanMs, coldMs}` — the benchmark hook above                                      |
| `/sandbox/execute`| POST   | `{code}`                                        | structured `ExecuteResult` `{status, logs, tests, result?, error?, ms}` (200 even when the guest timed out — the execution succeeded)   |

## Commands

- `npm run dev` — start `wrangler dev` (real workerd, local, no Cloudflare account) on http://localhost:8787
- `npm run check` — strict type-check (`tsc --noEmit`)
- `npm test` — vitest run (small-module specs only; worker-graph behavior lives in the live harnesses)
- `npm run test:live` — the live harnesses under real workerd (typecheck, sandbox, agent loop; the agent-shell harness joins with plan 05-02)
- `npm run bench:tsc-rs` — the benchmark table above (boots its own `wrangler dev`)
- `npm run bundle:check` — dry-run production bundle gate (no upload)
- `npm run gate:no-host-eval` — grep gate: no `eval`/`new Function` in src/ (QuickJS-WASM is the only execution path)

## Smoke test

```sh
npm run dev &
sleep 8
curl -s --max-time 5 http://localhost:8787/healthz
```

Returns the JSON envelope with the full runtime identity — `typechecker`/`sandbox` report
`"unloaded"` until the first real use (lazy singletons), and `workerd`/`userAgent` report
`navigator.userAgent` (best-effort: workerd has no in-band version API).
