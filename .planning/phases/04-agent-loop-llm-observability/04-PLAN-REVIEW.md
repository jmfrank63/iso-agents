# Plan Review: Phase 4

**Verdict:** REVISE

Reviewer: gsd-plan-checker | Date: 2026-10-12
Evidence basis: full read of both plans + current sources; live spot-compiles of the planned mock/guest-globals against real typescript@6.0.3 (repo node_modules, exact `GUEST_COMPILER_OPTIONS` + in-memory host replica, 57-file lib closure); live workerd clock probe (wrangler 4.149.0 / workerd 1.20261006.1, config-less scratch worker); hand-traced grep/assert censuses; `dist-bundle/index.js` baseline re-measured = 11,151,049 bytes (matches plan).

## Checks table

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | Coverage: all 11 IDs in frontmatter | PASS | 04-01 [CORE-02..05, LLM-01/02, OBS-01] ∪ 04-02 [CORE-01, CORE-04, LLM-03, TYPE-03, OBS-01/02] = exactly the 11 Phase 4 IDs |
| 1 | ROADMAP Phase 4 SC1–SC5 achieved | PASS | SC1→slugify 3-iter demo (fences divergence pinned as G4, CONTEXT wins); SC2→gate + CONTEXT status set; SC3→transcript; SC4→env LLM + per-step timings; SC5→stats + GET/404 |
| 1 | Statuses = run_deadline/llm_malformed (CONTEXT wins) | PASS | loop.ts `AgentStatus` terminal set; runs.ts composes `"running" \| AgentStatus`; old `"deadline"` literal gone from code (but see I3) |
| 2 | loop.ts deps injected, no static typescript import (WS-1009) | PASS | exactly 5 `import type` seams + 1 runtime import (extractor, pure); transpile injected as a function; verified runtime graph is typescript/quickjs-free |
| 2 | Typecheck gate before sandbox | PASS | CORE-03 gate short-circuits before transpile/sandbox; proven in loop.spec + harness iter1 asserts |
| 2 | Transpile conservative | PASS | `{ target: ES2022, isolatedModules: true }` only — pinned decision, no `module` override |
| 2 | GUEST_GLOBALS extension satisfies mock scenario | PASS (spot-compiled) | Planned `GUEST_GLOBALS_TEXT` + slugify iter1 → exactly 2 diags, d0 = TS2322 @ `/guest.ts`:2:9 (matches harness asserts); iter2/3 and fib iter2/3 → 0 errors; Phase 2 RED/GREEN/LIB_GUEST snippets unaffected (RED still TS2322 @1:7) |
| 2 | Per-request provider (no mock state races) | PASS | `createLlmProvider(env, …)` inside `handleAgentRun`; mock call counter is per-run |
| 2 | Windowing last-3 / deadline pre-LLM / FIFO 50 | PASS | `slice(-FEEDBACK_WINDOW)`; deadline checked at loop top before every complete + before corrective retry; `MAX_STORED_RUNS = 50` insert-order eviction |
| 3 | /typecheck new stats shape | PASS | `{runs, results:[{run,ms,ok}], minMs, medianMs, meanMs, coldMs}`; sorted-copy median, run-order `results`, `coldMs = results[0].ms`; runs default 5 clamp 1..100 |
| 3 | Phase 2 harness migration complete, no stale asserts | PASS | New harness: zero `data.ok`/`data.diagnostics[]`/`data.ms` asserts; 501 probe replaced by wired-route 400 probes; identity-flip + 405-header + validation cases retained; `grep -c "not_implemented"` → 0 |
| 3 | TS2322 exactness re-homed correctly | PASS (verified vs real tsc 6.0.3) | iter1 slugify: exactly 2 diagnostics; first = TS2322, line 2, column 9, file `/guest.ts`; second at line 3 — exactly as the agent harness asserts |
| 3 | 501→wired route with 400 validations | PASS | verbatim index.ts flips route; validation probes in both harnesses |
| 3 | healthz key ordering (agent LAST) | PASS | `agent: getAgentIdentity(env)` is the last property of the `getRuntimeInfo` literal; harness asserts last-key |
| 4 | Verbatim contents complete | PASS | All verbatim blocks are syntactically complete and internally consistent (loop retry scoping, provider import-at-bottom, mock template-literal escaping checked — no `${` hazards) |
| 4 | grep criteria hand-traced | **FAIL** | 3 wrong expected counts — I1, I2, I3 below |
| 4 | Verify commands exact | PASS | npm scripts all exist (`check`, `vitest run`, `test:live`, `bundle:check`, `gate:no-host-eval`); gate:no-host-eval stays clean (no `eval(`/`new Function(` in planned code) |
| 4 | Live harness boot/teardown robust | PASS | Process-group kill via in-process PID + port-scoped fuser backstop; no `pkill` self-match; free-port helper; 60s health poll; per-boot teardown in `finally` |
| 4 | llm_error case black-hole usage | PASS (mechanism) | In-process swallow-bytes server + `AbortSignal.timeout(1000)` → retry-once → `llm_error` under real `no_nodejs_compat` config; but the boot mixes it with a mock case that cannot pass — I1 |
| 4 | Timing `> 0` assertions plausible | **FAIL** | workerd `performance.now()` is whole-ms (probed: microtask await measures 0 ms; 60 small JSON.parses measure 0 ms) — I2 |
| 5 | Frontmatter validity | PASS | All required keys present; autonomous:true; no stray fields |
| 5 | files_modified complete | PASS | 04-01 lists all 11 touched files incl. the two edits (typecheck/index.ts, vfs.ts); 04-02 lists its 4; no cross-plan file overlap |
| 5 | Wave deps sane | PASS | 04-01 wave 1 (no deps) → 04-02 wave 2 (depends_on [04-01]); index.ts rewrite in 04-02 consumes 04-01 modules in order |
| 5 | Vitest counts hand-traced | PASS | 10 (sandbox-pure, existing) + 4 (migrated runs) + 6 (agent-pure) + 7 (loop) = 27 in 4 files; T3 checkpoint 2 files/12 tests correct (new specs land in T4) |
| 5 | Harness assert censuses | PASS as counted | typecheck harness 41 `^ok - ` lines and agent harness 53 `assert(` / 53 `^ok - ` lines both re-trace exactly (44 Boot A + 7 Boot B + 1 teardown + 1 definition) |

## Issues (blocking)

1. **04-02 T2a — Boot B's first case can never pass (env contradiction).** The boot spawns wrangler with `LLM_PROVIDER=openai` + black-hole `LLM_BASE_URL` **and** `MOCK_FAIL_AFTER=1`, then asserts a *mock* capped run (`max_iterations`, exactly 1 iteration, typecheck-failed). Under `LLM_PROVIDER=openai` the provider id is `openai-compatible`, so 04-02's own cap gate (`llm.id === MOCK_PROVIDER_ID`) does not fire and the run calls the black hole → terminal `llm_error` with 0 iterations after ~2 s. Both `capped` asserts fail, every time.
   **Fix:** split Boot B into two sequential boots: B1 with only `MOCK_FAIL_AFTER=1` (LLM_PROVIDER unset → mock) for the capped case; B2 with the openai/black-hole env for `llm_error` + identity flip. Update the census (Boot B grows by one teardown block) and the "two sequential boots" wording accordingly.
2. **04-01 T4 (loop.spec.ts) + 04-02 T2a (agent harness) — `> 0` timing assertions vs workerd's whole-millisecond clock.** Probed live in real workerd: `performance.now()` advances in 1 ms ticks; an `await Promise.resolve()` — exactly what the mock provider returns — measures **0** ms, and sub-ms sync work (60 small JSON.parses) also measures **0**. Therefore:
   - agent harness `"slugify run: llmMs positive on every iteration"` → every `it.llmMs` = 0 → FAIL;
   - agent harness aggregate assert → `t.llmMs > 0` = 0 → FAIL, and `t.transpileMs > 0` / `it2.transpileMs > 0 && it3.transpileMs > 0` are zero-to-flaky (single `transpileModule` of a ~350-byte guest is sub-ms-class work);
   - loop.spec.ts success test `expect(result.timings.totalMs).toBeGreaterThan(0)` → all-stub instant path totals 0 ms under the vitest-plugin's workerd → FAIL.
   **Fix:** for near-zero spans assert presence/finite, not positivity: `llmMs >= 0` + `Number.isFinite` (per-iteration and aggregate), `typeof it.transpileMs === "number" && it.transpileMs >= 0` (it1 null-check stays), and change the loop.spec totalMs assert to `toBeGreaterThanOrEqual(0)`. Keep `> 0` only where real work is included — `typecheckMs`/`sandboxMs`/`totalMs` in the agent harness are safe (real 8–20 ms checks + real QuickJS runs). OBS-01 requires the durations be *recorded*, not positive; 0 ms for a keyless mock call is honest.
3. **04-01 T4 acceptance — self-contradictory grep on runs.ts.** Criterion: `grep -c '"deadline"' src/runs.ts` prints exactly 0 — but the planned verbatim comment contains `ROADMAP's "deadline" is renamed "run_deadline"`, so grep prints **1** and the plan fails its own acceptance.
   **Fix:** reword the comment to avoid the quoted literal (e.g., `ROADMAP's deadline name is renamed "run_deadline"`), or change the expectation to 1 with a note.
4. **04-02 T1 verify — wrong expected count for MOCK_FAIL_AFTER.** `grep -c "MOCK_FAIL_AFTER" src/index.ts` claims `-> 1`; the planned verbatim has **3** matching lines (Env interface field, the G6 comment, the `parseOptionalPositiveInt(env.MOCK_FAIL_AFTER, …)` expression).
   **Fix:** expect 3 (or drop the line from the verify block).
5. **04-02 T1 acceptance — regex metacharacter bug in a grep criterion.** `grep -c "coldMs: results[0].ms" src/index.ts` expects 1, but in BRE `[0]` is a bracket expression matching the character `0`; the pattern cannot match the literal text `results[0].ms`, so it prints **0**.
   **Fix:** use `grep -cF "coldMs: results[0].ms"` or escape: `grep -c "coldMs: results\[0\].ms"`.

## Suggestions (non-blocking)

1. mock.ts's comment says the fibonacci iter-1 TS2322 sits "at `const next: string`" — the real compile (typescript@6.0.3, verified) reports the only diagnostic at line 8 (`b = next`; the `const next: string = String(a + b)` declaration is itself type-legal). Comment-only imprecision; nothing asserts fib positions, and the gate still fails → feedback → converge. Worth correcting while editing for I1/I2.
2. 04-01's plan-level note ("Do NOT run test:live … the /agent/run route still 501s") has an inverted rationale: at the 04-01 checkpoint the *old* harness still passes (it expects the 501 and the old /typecheck shape; the vfs change provably doesn't affect its snippets — spot-compiled). The "don't run" instruction itself is fine and can stay.
3. The extractor acceptance grep `grep -c "\b(?:import|export)\b" src/agent/extractor.ts → 1` is only correct because plain BRE treats `(?:` literally (it matches just the `SCRIPT_VIOLATION_PATTERN` line, not the comment lines' bare words). Fragile-but-correct; `grep -cF '\b(?:import|export)\b'` would state the intent plainly.
4. Boot B's llm_error case costs ~2 s (1 s timeout + one retry) inside the 30 s client timeout and 25 s default run deadline — sound; keep `LLM_TIMEOUT_MS=1000` exactly as planned so the margin stays wide.
5. runs.spec.ts's FIFO test was traced state-robust for any pre-existing registry size P (evictions = P + 2, oldest-global-first) — no change needed; noting the trace since count bugs are this phase's recurring risk.

## Verified-by-probe appendix

- **tsc 6.0.3 spot-compile** (repo node_modules, `GUEST_COMPILER_OPTIONS` + in-memory host replica, 57-lib closure): slug1 → 2 diags [TS2322 2:9, TS2322 3:3]; slug2/slug3/fib2/fib3 → 0 diags; fib1 → 1 diag TS2322 8:5; Phase-2 RED → TS2322 1:7 (unchanged); GREEN/LIB_GUEST → 0 diags; planned conservative transpile → 0 diags, `test(` survives in output.
- **workerd clock probe** (config-less scratch worker, wrangler 4.149.0): `performance.now()` tick deltas = [1,1,1,1,1,5,1,1] ms; `await Promise.resolve()` delta = 0 ms; 60× JSON.parse delta = 0 ms; 1 ms timer ≈ 2 ms.
- **Bundle baseline**: `dist-bundle/index.js` = 11,151,049 bytes — matches 04-02's stated baseline, so the +100,000 growth window is well-founded.
