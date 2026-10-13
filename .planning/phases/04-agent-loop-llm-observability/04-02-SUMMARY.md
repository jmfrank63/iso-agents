# Plan 04-02 Summary: Composition wiring + observability surface (wave 2)

**Status:** COMPLETE — all 3 tasks executed in order, full gate chain green, one mechanical deviation (boot-var delivery mechanism, see Deviations).

## Per-task notes

### T1 — Wire `src/index.ts` + migrate the Phase 2 harness
- `src/index.ts` rewritten verbatim from the plan: `POST /agent/run` flips 501 → the synchronous agent loop (validation 400s, per-request `createLlmProvider`, record created before the loop / finalized after, POST response IS the stored record, G6 `MOCK_FAIL_AFTER` cap for mock runs only, misconfigured-openai → honest `llm_error` record); `POST /typecheck` returns the TYPE-03 N-run stats shape (`{runs, results:[{run,ms,ok}], minMs, medianMs, meanMs, coldMs}`, default runs 5, clamp 1..100, sorted-copy median, `coldMs === results[0].ms`); `getRuntimeInfo(env)` appends `agent: getAgentIdentity(env)` LAST; `Env` gains `LLM_TIMEOUT_MS` / `AGENT_RUN_DEADLINE_MS` / `MOCK_FAIL_AFTER`.
- `scripts/test-typecheck-live.mjs` fully migrated to the stats shape: zero `data.ok`/`diagnostics`/`data.ms` asserts remain; the `501` probe replaced by wired-route 400-validation probes; TS2322 column exactness re-homed to the agent harness (per plan). 41 ok / 0 fail on first run.
- All T1 grep acceptance counts verified exactly: handleAgentRun 2, `501` 0, `fail(501` 0, MOCK_PROVIDER_ID 2, MOCK_FAIL_AFTER 3, `transpile: transpileGuest` 1, medianMs 2, `grep -cF "coldMs: results[0].ms"` 1, `agent: getAgentIdentity(env)` 1 (last property of the literal); harness: not_implemented 0, diagnostics 1, coldMs 6.

### T2 — Live agent harness + test:live chain
- `scripts/test-agent-live.mjs` created with the plan's verbatim assert set (all 53 `assert(` sites byte-identical to the plan); `package.json` chains it as the third `test:live` leg. 54 ok / 0 fail across three boots (44 Boot A + 3 Boot B + 4 Boot C + 3 teardown) — matches the plan census exactly.
- **Boot-var deviation (mechanism only):** the plan passed Boot B/C vars via spawn env (`env: {...process.env, ...extraEnv}`); live run proved `wrangler dev` does NOT inherit worker bindings from the OS environment (Boot B ran uncapped → success/3 iters; Boot C kept the mock identity). Fixed within intent: `spawnWrangler` now emits `--var KEY:VALUE` flags (documented wrangler flag; verified in wrangler-dist that `collectKeyValues` splits on the FIRST colon, so `LLM_BASE_URL:http://127.0.0.1:<port>` survives, and cliVars are injected as plain_text dev bindings). Call sites, env objects, and every assert unchanged. Re-run: 54 ok / 0 fail.

### T3 — Full gate chain
All five commands run in order, every exit 0 (see Gate results).

## Files + commits

| Commit | Files |
|---|---|
| `f5d3586` feat(04-02): wire POST /agent/run (synchronous loop, G6 mock cap, per-request provider), /typecheck N-run stats (TYPE-03), healthz agent key last; migrate typecheck harness to stats shape (T1) | src/index.ts, scripts/test-typecheck-live.mjs |
| `2dfe096` feat(04-02): live agent harness — 3 sequential wrangler boots (mock gate sequence, MOCK_FAIL_AFTER cap, black-holed openai llm_error), chained into test:live (T2) | scripts/test-agent-live.mjs, package.json |

T3 changed no files. No new npm dependencies. `.planning/` not committed; nothing pushed.

## Gate results

| Gate | Result |
|---|---|
| `npm run check` | exit 0 |
| `npx vitest run` | exit 0 — **Test Files 4 passed (4), Tests 27 passed (27)** |
| `npm run test:live` | exit 0 — **135 ok / 0 fail** total: typecheck harness 41, sandbox harness 40 (untouched, green), agent harness 54 (Boot A 44 / Boot B 3 / Boot C 4 / teardown 3) |
| `npm run bundle:check` | exit 0 — `dist-bundle/index.js` = **11,173,644 bytes**; baseline 11,151,049 + 22,595 growth (budget < 100,000; agent modules are plain TS, zero new deps) |
| `npm run gate:no-host-eval` | exit 0 (SAND-01 invariant untouched) |

## Observed mock-loop behavior + timings (instrumented one-off boot, same worker/code)

Slugify run — `status: "success"` in exactly 3 iterations, gate order **typecheck-fail → sandbox-fail → success**:
- iter1: llmMs 0 · typecheck **234 ms (cold — first checker use parses the 57-file lib closure)** · ok=false, 2 diagnostics, first = TS2322 at `/guest.ts`:2:9 · sandbox skipped (CORE-03) · transpileMs null
- iter2: llmMs 0 · typecheck **9 ms (warm)** · transpile 17 ms · sandbox 37 ms, status ok, 1/2 tests failed (`expected "a-b", got "-a-b-"`)
- iter3: llmMs 0 · typecheck 8 ms · transpile 4 ms · sandbox 2 ms, 2/2 tests passed (trim-corrected code)
- Aggregate: `{llmMs: 0, typecheckMs: 251, transpileMs: 21, sandboxMs: 39, totalMs: 323}` — totalMs ≥ sum of parts holds
- llmMs = 0 on every iteration, exactly as the plan-review whole-millisecond-clock finding predicted (mock reply is one resolved microtask)

Fibonacci run: success, 3 iterations, totalMs 63 (typecheckMs 48 / transpileMs 10 / sandboxMs 5). Generic "mystery assignment" task converged via the fibonacci fallback. `maxIterations: 1` request → `max_iterations` in 19 ms wall. Boot C black-holed openai: retry-once (2 × 1 s `AbortSignal.timeout`) → `llm_error`, 0 iterations, GET-retrievable. Cold-vs-warm checker visible live: 234 ms first check → 8–9 ms warm (the memoization/tsc-rs story in numbers).

## Deviations

1. **T2a boot-var mechanism (mechanical, in-intent):** plan delivered Boot B/C vars via spawn env; wrangler dev ignores OS env for worker bindings (proven live). Switched to `wrangler dev --var KEY:VALUE` flags inside `spawnWrangler` (+ 5-line header note). No assert, env value, or boot structure changed. This closes the only red run of the plan; all green afterward.
2. **Invocation note (no file change):** the harnesses spawn `wrangler` via PATH, so direct `node scripts/test-*-live.mjs` invocations require `node_modules/.bin` on PATH (`PATH="$PWD/node_modules/.bin:$PATH"` was used); `npm run test:live` needs no prefix.
3. **Foreign processes observed, untouched:** pre-existing wrangler/workerd processes from earlier sessions (ports 8799/8842/8843; `/tmp/qjs-spike` and `wrangler dev worker.js` command lines) were left running per the never-`pkill -f wrangler` discipline. Every harness-owned boot was killed by its own PID/process group with port-freed verification (`ok - teardown` × 3 per agent-harness run, × 1 per typecheck-harness run); a PID-file probe boot was likewise killed by PID and its port verified freed.
