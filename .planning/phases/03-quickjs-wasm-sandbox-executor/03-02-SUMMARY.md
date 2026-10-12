# Plan 03-02 Summary: Wiring + live proof — sandbox route, identity flip, live guardrail harness, full phase verification

**Status:** COMPLETE — all 3 tasks executed sequentially, every verify/acceptance gate passed (2 plan-grep-pattern notes recorded under Deviations), no content deviations from plan.

**Date:** 2026-10-12

## Per-task notes

### Task 1 — Wire worker (commit c346082)
- `src/index.ts` edited with the plan's 7 surgical edits (a–g), all content verbatim: sandbox imports, `SANDBOX_MEMORY_LIMIT_MB?` + `SANDBOX_STACK_KB?` in `Env`, `sandbox: getSandboxIdentity()` in `getRuntimeInfo()`, `env: Env` fetch signature, `handleSandboxExecute` block below `handleTypecheck`, `case "POST /sandbox/execute"` in the switch, `"/sandbox/execute": "POST"` in `KNOWN_PATHS`.
- `npm run check` exit 0. All grep gates matched; two verify-pattern notes (see Deviations 1–2): `getSandboxRuntime` counts 3 not 2 (the plan's own verbatim handler comment contains the third mention), and the KNOWN_PATHS grep needs the leading `/` to match the plan's own required content.
- `await handleTypecheck(request)` still present — Phase 2 route untouched; `POST /agent/run` still 501 (proved live by the typecheck harness).

### Task 2 — Live harness + test:live chain + no-host-eval gate (commit b917236)
- `scripts/test-sandbox-live.mjs` written verbatim (11 case groups mapped to the research failure-mode matrix; PID-process-group teardown + free-port + port-freed verification; never `pkill -f wrangler`). `node --check` exit 0.
- `package.json`: `test:live` now chains `test-typecheck-live.mjs && test-sandbox-live.mjs`; new last script `gate:no-host-eval` = `! grep -rnE '\beval\(|new Function\(' src/`.

### Task 3 — Full phase verification (no commit — phase gate, zero file changes per plan)
- Full gate chain green end-to-end, twice for the live portion. Observed while-true wall times: **776 ms** (run 1) and **772 ms** (run 2), both far inside the deadline+250 ms = 2250 ms bound; `wrangler dev` survived both (subsequent executions green — guardrail mechanism correct, no hang).

## Gate-chain results

| Gate | Result |
|---|---|
| `npm run check` | exit 0 |
| `npm test` | **12 passing / 0 failing** (runs.spec 2 + sandbox-pure 10; no worker/sandbox graph import) |
| `npm run gate:no-host-eval` | exit 0 (zero `\beval(`/`new Function(` in src/) |
| `node scripts/copy-quickjs-wasm.mjs` | "already up to date (503134 bytes)" — postinstall idempotence holds |
| `npm run bundle:check` Total Upload | **11,839.95 KiB raw / 2,029.37 KiB gzip** |
| Bundle delta vs Phase 2 baseline (11,246.93 / 1,777.83) | **+593.02 KiB raw / +251.54 KiB gzip** (research-measured ≈ +608 / +254 KiB; floor gate > 11,247 passes) |
| `.wasm` sibling in dist-bundle | 1 (`02028007bab4b877246b6f1a77434d1ce18122e5-quickjs.wasm`) |
| `lib.` siblings | 57 (unchanged from Phase 2) |
| `node:` refs in dist-bundle/index.js | 0 |
| `npm run test:live` | exit 0 — **both harnesses green, zero `FAIL - ` lines** |

## Live harness assertion counts + observed timeout behavior

| Harness | `ok -` assertions | `FAIL -` |
|---|---|---|
| test-typecheck-live.mjs (Phase 2 re-proof) | 42 | 0 |
| test-sandbox-live.mjs (11 case groups) | 40 | 0 |

Sandbox harness coverage: pre-state `unloaded` → green spec (status ok, result 42, 3/3 tests, ms>0, no logs) → console capture (log/warn/error, primitives, object, Error→{name,message}) → failing assertion (passed:false, "expected 3, got 2", later test still ran) → guest throw ("Error: boom") → **while(true): structured `timeout`, wall 776 ms < 2250 ms, error mentions deadline** → SAND-04 fresh-context after timeout → deep recursion (catchable "stack overflow" at 64 KiB) → SAND-04 fresh-context after overflow → memory hog (catchable "out of memory") → async gate ×2 (async fn + `Promise` rejected pre-eval) → transpiled TS guest (ts.transpileModule → ok, assertion passes, result 36) → route validation (400 ×2, 405 + `allow: POST`) → identity flip (`quickjs-wasmfile-release-sync@0.32.0`) → teardown ok (port freed).

Run 2 re-verified: exit 0, `FAIL - ` count 0, while-true wall 772 ms, all key labels present (while-true timeout, SAND-04, flip, teardown).

## Files + commits

| Commit | Files |
|---|---|
| c346082 `feat(03-02): wire worker — …` | src/index.ts |
| b917236 `test(03-02): live sandbox guardrail harness …` | scripts/test-sandbox-live.mjs, package.json |

Task 3: no commit (zero file changes — phase-gate task per plan). `.planning/` untouched; nothing pushed.

## Deviations

No file-content deviations — every file byte-matches the plan's specified content. Three record-keeping notes:

1. **Task 1 verify pattern undercounts:** `grep -c 'getSandboxRuntime' src/index.ts` returns **3**, not the planned 2 — the plan's own verbatim handler comment ("Phase 4's agent loop calls getSandboxRuntime(env).execute() directly") is the third match beyond import + call. Content kept verbatim (authoritative); the count expectation in the plan is internally inconsistent with its own action text.
2. **Task 1 verify pattern typo:** `grep -q '"sandbox/execute": "POST"'` (no leading slash) cannot literally match the plan's own required KNOWN_PATHS entry `"/sandbox/execute": "POST",`. Verified with the corrected pattern `grep -q '"/sandbox/execute": "POST"'` → match. Content per plan.
3. **Out-of-scope strays observed:** after the live runs, pre-existing `wrangler dev`/workerd processes from the earlier research spike (`/tmp/qjs-spike`, port 8799) were still running. They were NOT spawned by this plan's harnesses (both teardowns printed `ok - teardown: wrangler killed and port closed`); left untouched per the never-`pkill -f wrangler` rule and task scope.
