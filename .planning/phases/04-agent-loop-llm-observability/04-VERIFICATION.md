# Phase 4 Verification: Agent loop + LLM + observability

**Verdict:** DELIVERED
**Verified:** 2026-10-13 (independent re-verification — full gate chain re-run, live capstone re-executed on a fresh self-booted `wrangler dev` with PID-file teardown; summaries not trusted)
**Method:** static gates re-run (`check`, `vitest run`, `gate:no-host-eval`, `bundle:check`), `npm run test:live` re-run end-to-end (135 ok / 0 fail), plus an independent capstone spot-check harness (`/tmp/phase4-capstone-check.mjs`) that booted its own `wrangler dev` (mock defaults, `--var`-free) with PID-based teardown and port-freed verification.

## Gate results (re-run this session)

| Gate | Result |
|---|---|
| `npm run check` | exit 0 |
| `npx vitest run` | **Test Files 4 passed (4), Tests 27 passed (27)** |
| `npm run gate:no-host-eval` | exit 0 |
| `npm run bundle:check` | exit 0 — `dist-bundle/index.js` = **11,173,644 bytes** (matches 04-02 summary byte-for-byte; total upload 11,862.02 KiB / gzip 2034.86 KiB) |
| `npm run test:live` | exit 0 — **135 ok / 0 fail**: typecheck harness 41 (incl. teardown), sandbox harness 40, agent harness 54 (Boot A 44 + Boot B 3 + Boot C 4 + 3 teardowns) — matches the summaries' census exactly |

## Requirements table

| Req | Requirement (REQUIREMENTS.md) | Verdict | Evidence |
|---|---|---|---|
| CORE-01 | `POST /agent/run` accepts `{task, spec}` and runs the full loop to green or guardrail | **DELIVERED** | Route wired synchronous: src/index.ts:194-256 (validation 400s :196-218, loop invocation :243-252). Live (own boot): slugify run → `status:"success"`; guardrails live-proven: `max_iterations` (request cap `maxIterations:1` + Boot B `MOCK_FAIL_AFTER=1`), `llm_error` (Boot C black-holed openai), `run_deadline`/`llm_malformed` code paths (loop.ts:127-129, 224). |
| CORE-02 | Loop iterates LLM → VFS write → typecheck → transpile → sandbox → assertions → structured feedback → next LLM | **DELIVERED** | Full pipeline in src/agent/loop.ts:124-322 (deadline :127 → LLM :135-145 → extraction w/ corrective retry :151-182 → typecheck gate :228 → single-file gate :249-265 → transpile :267 → sandbox :288 → feedback/success :293-321). Live transcript shows files rewritten between iterations, feedback text on iters 1-2, convergence on iter 3. |
| CORE-03 | Type errors gate execution: failing typecheck skips sandbox, diagnostics feed back | **DELIVERED** | Gate short-circuits before transpile/sandbox: src/agent/loop.ts:227-244 (`sandbox: null, transpileMs: null`, `continue`). Live: iter1 `typecheck.ok=false` with TS2322 @ `/guest.ts`:2:9, `sandbox:null` (own boot + agent harness Boot A + `maxIterations:1` capped run). |
| CORE-04 | Stops on success / max iterations / deadline with distinct terminal statuses | **DELIVERED** | `AgentStatus = "success" \| "max_iterations" \| "run_deadline" \| "llm_error" \| "llm_malformed"` (loop.ts:17 — the CONTEXT set: ROADMAP's deadline name renamed `run_deadline`, `llm_malformed` added; plan review check passed). All five unit-proven (test/loop.spec.ts:106,152,160,168,176); success/max_iterations/llm_error additionally live-proven. Deadline checked pre-LLM each iteration (loop.ts:127). |
| CORE-05 | Response returns full transcript: LLM output, files, diagnostics, sandbox stdout/result, assertions, feedback | **DELIVERED** | `AgentIteration {n, llmMs, explanation, files, typecheck{ok,diagnostics,ms}, transpileMs, sandbox{status,logs,tests,result,ms}, feedback}` (loop.ts:19-28). Live transcript contains all: explanation, per-iteration `files["guest.ts"]`, 2 diagnostics with code/line/column/file/category, sandbox `tests[{name,passed,error}]`, feedback strings ("type errors — fix…", "FAILED test \"trims and collapses separators\"…"). |
| LLM-01 | LLM access behind `LlmProvider` interface; provider from env, default mock | **DELIVERED** | `LlmProvider` seam (provider.ts:31-34); factory `createLlmProvider`: `env.LLM_PROVIDER ?? "mock"` → mock default (provider.ts:55-72); constructed PER REQUEST in the route (index.ts:230). Loop depends only on the interface (loop.ts:49). |
| LLM-02 | Mock stateful + imperfect: broken first response, converges, zero API keys | **DELIVERED** | Planted 3-turn progressions SLUGIFY/FIBONACCI (mock.ts:29-121): iter1 type error + (iter2) planted logic bug, iter3 correct; per-instance call counter (mock.ts:135-142); scenario sniff on (task,spec) seed (mock.ts:125-127) with fibonacci generic fallback (live-proven: "mystery assignment" → fibonacci success). Live: 3 iterations typecheck-fail → sandbox-fail → success with zero keys. |
| LLM-03 | OpenAI-compatible provider via `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`, no code changes | **DELIVERED** | `OpenAiCompatibleLlmProvider`: one `fetch` POST `${baseUrl}/chat/completions`, bearer auth, retry-once on 5xx/429/timeout/network via `err.name` classification (provider.ts:86-144). Live Boot C: `LLM_PROVIDER=openai` + black-hole base URL + `LLM_TIMEOUT_MS=1000` → retry-once → `llm_error` under real `no_nodejs_compat`; healthz identity flips to `openai-compatible`. Misconfigured openai → honest `llm_error` record (index.ts:231-236). |
| TYPE-03 | `POST /typecheck` N-run latency stats (min/median/mean) — tsc-rs benchmark hook | **DELIVERED** | src/index.ts:117-179: `{runs, results:[{run,ms,ok}], minMs, medianMs, meanMs, coldMs}`; default runs 5, clamp 1..100 (:33-34,136-147); sorted-copy median (:161-164); `coldMs = results[0].ms` (:174). Live: `runs:3` → 3 results each ms>0, `{minMs:3, medianMs:4, meanMs:5, coldMs:8}`, coldMs ≥ minMs. |
| OBS-01 | Every step records wall-clock duration (LLM/typecheck/transpile/sandbox/total ms), in response AND stored with run | **DELIVERED** | `AgentTimings {llmMs, typecheckMs, transpileMs, sandboxMs, totalMs}` accumulated via `performance.now()` (loop.ts:30-36, 112-117); POST response IS the stored record (index.ts:253-255, finalize mutates in place — runs.ts:49-62). Live: aggregate `{llmMs:1, typecheckMs:258, transpileMs:21, sandboxMs:38, totalMs:330}` present in both POST and GET (byte-identical). |
| OBS-02 | `GET /agent/run/:id` returns stored run (transcript + timings + status); unknown id → 404 | **DELIVERED** | Registry route index.ts:319-331; FIFO-50 store runs.ts:21-44. Live: GET roundtrip byte-identical to POST response; random UUID → 404 `not_found` envelope. |

## Success criteria table (ROADMAP Phase 4)

| SC | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | `POST /agent/run` with `{task, spec}` runs the full loop with the default deterministic mock — zero API keys; mock stateful + deliberately imperfect; `iterations >= 2` on the bundled fixture | **DELIVERED** | Live: mock run succeeds with **3 iterations** (broken-first → error-driven fix), zero keys. One documented refinement: the mock emits clean JSON always; fence stripping exists for real providers (04-CONTEXT.md decision, plan-review approved) — the "markdown fences" wording in ROADMAP was superseded by the CONTEXT decision. Imperfection + statefulness + convergence all hold. |
| 2 | Type errors gate execution (sandbox skipped, diagnostics straight back); distinct terminal statuses | **DELIVERED** | See CORE-03/CORE-04. Live gate order observed: **typecheck-fail → sandbox-fail → success**; statuses `success`/`max_iterations`/`llm_error` live; `run_deadline`/`llm_malformed` unit-proven. |
| 3 | Response carries the full transcript | **DELIVERED** | See CORE-05; condensed live transcript below. |
| 4 | Env vars activate OpenAI provider with no code changes; every step's wall-clock duration in the response and stored | **DELIVERED** | See LLM-03/OBS-01. All five timing fields present and stored; `totalMs ≥ sum of parts` asserted live (agent harness). |
| 5 | `POST /typecheck` N-run stats (min/median/mean); `GET /agent/run/:id` returns stored run with honest 404 | **DELIVERED** | See TYPE-03/OBS-02. Live: stats shape complete; roundtrip + 404 proven on own boot and in Boot A. |

## Milestone definition-of-done check (ROADMAP v1)

| # | DoD item | Verdict | Evidence |
|---|---|---|---|
| 1 | `/healthz` full runtime identity; real workerd, no account/tokens; clean builtin-free bundle | **DELIVERED** | Own boot: healthz 200 with workerd identity, compatibility_date `2026-09-01`, instanceId; typechecker/sandbox identities flip `unloaded` → `typescript@6.0.3 (in-isolate)` / `quickjs-wasmfile-release-sync@0.32.0` after first use; `agent` key LAST. Boot needed no account/token. Bundle: dry-run exit 0; zero `node:` imports in src/ (grep). |
| 2 | `POST /typecheck` real in-isolate diagnostics + N-run stats | **DELIVERED** | Live: stats shape complete (TYPE-03 row); red-snippet `results[0].ok=false` proven in agent harness (test:live line "typecheck stats: red snippet flags results[0].ok=false"). |
| 3 | `POST /agent/run` mock loop to green or distinct guardrail, transcript + per-step timings | **DELIVERED** | Capstone run below: success in 3 iterations, full transcript, all five timings. |
| 4 | `GET /agent/run/:id` replay; env vars swap in OpenAI provider, zero code changes | **DELIVERED** | Live roundtrip byte-identical; Boot C proves provider swap purely via `--var` env (no code change). |
| 5 | Sandboxed QuickJS-WASM guardrails proven before the loop; no host eval | **DELIVERED** | Phase 3 verified (03-VERIFICATION.md); this session: `gate:no-host-eval` exit 0, sandbox harness 40/40 ok inside `test:live`. |
| 6 | All 21 v1 requirements validated + moved to PROJECT.md "Validated"; tsc-rs seam documented | **PARTIAL — bookkeeping pending (expected)** | tsc-rs seam documented at the `Typechecker` interface with the native-only/no-WASM constraint (src/typecheck/index.ts:22-30) ✅. But .planning/PROJECT.md "Validated" section is still "(None yet — ship to validate)" and REQUIREMENTS.md traceability rows all read "Pending" — this is the post-verification step this file unblocks, not a code gap. |

## Capstone live log (condensed run transcript JSON — own boot, mock defaults)

`POST /agent/run {"task":"implement slugify","spec":"slugify(s: string): string — lowercase, trim, spaces+underscores to single hyphens, strip non-alphanumeric except hyphens, trim hyphens; two test() calls"}`:

```json
{
 "id": "81622496-532f-4abd-966d-7e81e458c152",
 "status": "success",
 "iterations": [
  {"n": 1, "llmMs": 1,
   "typecheck": {"ok": false, "ms": 241, "nDiags": 2,
    "d0": {"code": 2322, "message": "Type 'string' is not assignable to type 'number'.", "line": 2, "column": 9, "file": "/guest.ts", "category": "Error"}},
   "transpileMs": null, "sandbox": null,
   "feedback": "type errors — fix and return the FULL file(s) again:"},
  {"n": 2, "llmMs": 0,
   "typecheck": {"ok": true, "ms": 9, "nDiags": 0}, "transpileMs": 17,
   "sandbox": {"status": "ok", "ms": 35, "tests": [
     {"name": "lowercases and hyphenates", "passed": true},
     {"name": "trims and collapses separators", "passed": false, "error": "Error: expected \"a-b\", got \"-a-b-\""}]},
   "feedback": "FAILED test \"trims and collapses separators\": Error: expected \"a-b\", got \"-a-b-\""},
  {"n": 3, "llmMs": 0,
   "typecheck": {"ok": true, "ms": 8, "nDiags": 0}, "transpileMs": 4,
   "sandbox": {"status": "ok", "ms": 3, "tests": [
     {"name": "lowercases and hyphenates", "passed": true},
     {"name": "trims and collapses separators", "passed": true}]},
   "feedback": null}
 ],
 "timings": {"llmMs": 1, "typecheckMs": 258, "transpileMs": 21, "sandboxMs": 38, "totalMs": 330}
}
```

Other own-boot spot-checks (all pass):

- **healthz before run:** `typechecker:"unloaded"`, `sandbox:"unloaded"`, `agent:"mock-provider ready"`; **after run:** `typescript@6.0.3 (in-isolate)`, `quickjs-wasmfile-release-sync@0.32.0`; `agent` is the LAST runtime key (before and after).
- **GET roundtrip:** `GET /agent/run/81622496-…` → byte-identical to the POST response. `GET /agent/run/<random-uuid>` → 404 `{ok:false, error:{code:"not_found"}}`.
- **Validation:** missing `task` → 400 `bad_request` envelope.
- **`POST /typecheck {"files":{"/t.ts":"const a: number = 1;"},"runs":3}`** → `{runs:3, results:[{run:1,ms:8,ok:true},{run:2,ms:4,ok:true},{run:3,ms:3,ok:true}], minMs:3, medianMs:4, meanMs:5, coldMs:8}` — every ms>0, coldMs ≥ minMs (warm-isolate cold run post-agent-run; the 241 ms true-cold check is visible in the agent run's iter1).
- **Teardown:** wrangler killed by PID from the PID file, port verified freed (no fuser backstop needed).

## Conformance

| Check | Result | Evidence |
|---|---|---|
| `LLM_PROVIDER` unset → mock default | **PASS** | `const kind = env.LLM_PROVIDER ?? "mock"` (provider.ts:56-58); live default boot reports `agent:"mock-provider ready"` and runs the mock scenario. |
| openai path reads `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` | **PASS** | provider.ts:60-69 (misconfig throw without BASE_URL/MODEL) and :110-119 (POST to `${baseUrl}/chat/completions`, optional bearer); live Boot C exercised with all four vars + `LLM_TIMEOUT_MS`. |
| CORE-03 gate order in loop.ts | **PASS** | typecheck (loop.ts:228) → gate `continue` on failure (:230-244) strictly precedes transpile (:267) and sandbox (:288); failure iteration records `sandbox:null, transpileMs:null`. Live iter1 confirms. |
| CORE-04 five terminal statuses | **PASS** | loop.ts:17 exact set `success/max_iterations/run_deadline/llm_error/llm_malformed`; runs.ts:9 composes `"running" \| AgentStatus`; all five asserted in test/loop.spec.ts; no `"deadline"` literal anywhere. |
| OBS fields in the stored record | **PASS** | `RunRecord` carries `iterations[]` + `timings` (runs.ts:11-19); `AgentTimings` has all five fields (loop.ts:30-36); finalize stores both (runs.ts:53-62); POST response IS the stored record (index.ts:253-255). |
| FIFO-50 registry | **PASS** | `MAX_STORED_RUNS = 50`, insertion-order eviction of the oldest key on create (runs.ts:21, 27-31); unit-proven in test/runs.spec.ts. |
| Deadline pre-LLM / windowing last-3 / per-request provider | **PASS** | loop.ts:127-129 (deadline before every LLM call incl. corrective retry via the :157 guard), :72+:132 (`slice(-FEEDBACK_WINDOW)`), index.ts:230 (provider per request). |
| Boot identity assert (TS 6.0.3, no `process`) | **PASS** | typecheck/index.ts:35-50; live healthz identity `typescript@6.0.3 (in-isolate)`. |

## Gaps

- **None in code or live behavior.** The only open item is milestone-DoD bookkeeping: the 21 validated requirements have not yet been moved to PROJECT.md "Validated" / REQUIREMENTS.md status (that move is the step this verification unblocks — DoD item 6 PARTIAL on process, not on implementation).
- Note (non-gap): ROADMAP SC1's "markdown fences" wording for the mock was superseded by the 04-CONTEXT decision (mock always clean JSON; fence stripping serves real providers) — plan-review-approved, does not affect the criterion's intent (imperfect-first-response → error-driven fixes → `iterations >= 2`).
