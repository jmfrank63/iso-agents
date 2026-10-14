# Milestone v5 SUMMARY: Hardening — GPT-6.1-Sol review remediation

**Status: DELIVERED** (2026-10-14). All 11 review findings fixed, each with its
regression proof. No open findings remain from `.planning/reviews/2026-10-14-gpt61sol.md`.

## Per-task table

| Task | Status | Fix (one line) | Commit(s) | Regression proof |
|---|---|---|---|---|
| H1 wasm checker must check every submitted file | done | explicit `files`-list tsconfig (every submitted source + trusted globals, /app-anchored absolute) + extension guard (`src/typecheck-wasm/guard.ts`) | 0159945, 8b6c4cd | unit guard spec; live: nested `dir/guest.ts` TS2322 flagged (was ok:true) + clean post-check |
| H2 guest paths cannot collide with compiler-owned files | done | reserved-path guard (`/tsconfig.json`, `/guest-globals.d.ts`); 400 bad_request at `/typecheck` (wasm mode) + `/agent/shell` mapping; checker seed guard double-checks | f5ea10e | unit reserved-path spec; live: guest `tsconfig.json` -> 400 bad_request (not a clean verdict) |
| H3 held-fs sync ordered + fully inside recycle | done | `memfs.syncFiles` removes obsolete BEFORE writing; `runTscHeld` wraps sync+prep+run+decode in one try/catch that drops held state on ANY throw | 54fcd5b | unit sync-ordering spec; live: `dir.ts` -> `dir.ts/guest.ts` second check SUCCEEDS, same generation; leg-B recycle flow intact (gen 2->3) |
| H4 run deadline bounds every stage and retry | done | post-stage `expired()` checks (LLM, retry, typecheck, sandbox) + before success; provider attempts inherit remaining budget (no fresh timeout); `run_deadline` terminal | 77596c8 | unit loop specs (overrun -> run_deadline before gates; green-after-deadline never success) + provider.spec (0 fetches / retry skip / retry-with-budget); live: 3-iteration mock loops still converge (25s default budget untouched) |
| H5 guests cannot fabricate test evidence | done | closure-private records array (harness IIFE completion value); runtime retains a private host handle; test/expect/assert locked (non-writable/non-configurable) | 5617d1d, 13e7396 | unit privacy/resistance specs (real `makeHarness`, no codegen); live: fabricated `__tests` ignored, strict reassignment throws |
| H6 type-aware assertions | done | `deepEqual` without JSON pitfalls (NaN fails everything, undefined !== fn, recursive arrays/objects, functions by reference); toBeCloseTo validates finite operands + tolerance | f82fb38 | unit assertion specs incl. all reviewer repros; live: NaN cases both FAIL |
| H7 finalize survives FIFO eviction | done | `finalize(run, ...)` mutates the caller-held reference; `create` never evicts a RUNNING record while terminated ones exist (all-running burst falls back to FIFO) | 672d264 | unit: evict-then-finalize leaves no record running; active-run protection; live: run/GET roundtrips unchanged |
| H8 unexpected failures finalize the run | done | `AgentLoopError` carries the partial transcript; `/agent/run` catch finalizes terminal `internal_error` (new RunStatus) then returns the Phase 1 500 envelope | 1a962ac | unit: checker crash mid-run rejects with partial transcript; wiring HTTP-bound — verified by inspection + existing 500 paths green |
| H9 JSON-safe sandbox values | done | `sandbox/console.ts` `jsonSafe()` (BigInt -> string, cycles -> "[circular]", DAGs preserved) applied to result + console args BEFORE accounting | e21c913 | unit console.spec; live: `execute(1n)` -> 200 result "1"; `console.log(1n)` captured |
| H10 console cap bounds retained bytes | done | per-entry retention budget: strings truncated to remaining capacity, oversized non-strings -> "[unserializable]"; cap checked before retention, never after dump | e21c913, 2684fe7 | unit fitLogArgs specs; live: 1 MB console arg retained <= 8192 bytes |
| H11 execution failures surface in feedback | done | status+error lead the feedback when `exec.status !== "ok"`; "no test() calls found" alone only for a clean test-less execution | 3ec66a0 | unit: timeout/crash feedback contains "sandbox timeout/crash: ..."; clean missing-tests text unchanged (pre-existing spec green) |

## Files + commits (13 commits, in order)

| Commit | Task | Files |
|---|---|---|
| 0159945 | H1 | src/typecheck-wasm/guard.ts (new), src/typecheck-wasm/checker.ts, test/typecheck-wasm-guard.spec.ts (new), scripts/test-typecheck-wasm-live.mjs |
| f5ea10e | H2 | guard.ts, src/index.ts, guard spec, wasm live harness |
| 8b6c4cd | H1 fix | checker.ts (/app-absolute files list; fork resolves entries vs cwd) |
| 54fcd5b | H3 | src/typecheck-wasm/memfs.ts (syncFiles), shim.ts, mapping.spec, wasm live harness |
| 77596c8 | H4 | src/agent/provider.ts, src/agent/loop.ts, test/loop.spec.ts, test/provider.spec.ts (new) |
| 5617d1d | H5 | src/sandbox/harness.ts, src/sandbox/runtime.ts, test/sandbox-pure.spec.ts |
| f82fb38 | H6 | harness.ts, sandbox-pure.spec.ts |
| 672d264 | H7 | src/runs.ts, src/index.ts, test/runs.spec.ts |
| 1a962ac | H8 | loop.ts (AgentLoopError), index.ts, loop.spec.ts |
| e21c913 | H9 | src/sandbox/console.ts (new), runtime.ts, test/console.spec.ts (new) |
| 13e7396 | H5 fix | harness.ts (identity `__name` shim — keepNames bundling), sandbox-pure.spec.ts |
| 2684fe7 | H10 | scripts/test-sandbox-live.mjs (H5/H6/H9/H10 live cases) |
| 3ec66a0 | H11 | loop.ts, loop.spec.ts |

## Gate results (final)

| Gate | Result |
|---|---|
| `npm run check` | clean (tsc --noEmit, 0 errors) |
| vitest | **109/109 passed** (64 pre-existing + 45 new), 10 files |
| `npm run gate:no-host-eval` | green |
| `npm run bundle:check` | green — Total Upload 16,926.58 KiB / gzip 4,200.13 KiB |
| `npm run test:live` (5 harnesses) | **251 ok / 0 FAIL** — typecheck 41, sandbox 47, agent 54 (3 boots), shell 54, wasm 55 (2 boots) |

Reviewer's must-fix top 3 re-verified live in workerd: H1/H2 (checker gate — nested
guest flagged, compiler-owned paths 400), H3 (recycle on every failure path; recycle
boundary + error-recycle asserts unchanged and green), H4 (deadline; mock loop
converges in exactly 3 iterations under the 25 s default budget, wasm agent leg green).

## Deviations

1. **H1 second commit (8b6c4cd):** the first files-list seeding used bare relative names;
   live probing showed ts_goport resolves tsconfig `files` entries against the process
   cwd (frozen to "/") instead of the tsconfig directory — TS6053 "File '/guest.ts' not
   found" on every check. Fixed by /app-anchored absolute entries (resolution-base
   independent). Discovered during H3's live run; committed as an H1 follow-up for
   task attribution.
2. **H5 second commit (13e7396):** wrangler's esbuild `keepNames` decorates the
   stringified harness with `__name(...)` statements that don't exist inside QuickJS
   (live repro: harness setup failed on every sandbox execution). Fixed with an
   identity `__name` shim inside the injected source's IIFE (hand-written string —
   esbuild cannot decorate it back; IIFE scope keeps it off the guest global). The
   harness shape contract (self-contained function; declarations + shorthand methods)
   is documented in src/sandbox/harness.ts.
3. **H10 commit shape:** the retention policy (`fitLogArgs`) and runtime wiring landed
   together with H9's `sandbox/console.ts` module (one cohesive pure module); H10's own
   commit (2684fe7) carries the live proof. Recorded here for honest attribution.
4. **H8 live proof:** the checker-trap path is not reachable through `/agent/run` with
   the deterministic mock (the mock never emits trap code), so the finalization wiring
   is proven by unit tests (AgentLoopError partial transcript, runs.ts finalize
   semantics) plus inspection; the wasm harness's structured-500 error path (leg B)
   stays green, which exercises the shared catch surface.
5. **`internal_error` is a new terminal RunStatus** (HTTP-layer only; the agent loop
   never returns it). The CONTEXT "locked set" is extended by one member per the plan's
   explicit allowance ("llm_error family or new internal_error").
6. All live proof counts for the wasm harness were adapted WITHOUT changing generation
   semantics: H3's ordering fix keeps the mtime stamping + held-stats contract — leg A
   reuse asserts (instanceGen 1, runsOnInstance 3 -> 4) and leg B recycle asserts
   (gen 1 -> 2 -> 3, recycles 1 -> 2) pass unchanged; the only counter nuance is that a
   sync failure no longer increments runsOnInstance (no ts_run happened — honest count).
7. Pre-existing `docs/benchmarks.md` working-tree diff (bench regen timestamp from
   2026-10-13) is NOT part of this milestone and remains uncommitted.
