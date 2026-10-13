# Plan Review: Phase 5

**Verdict:** REVISE

**Scope:** 05-01-PLAN.md (tsc-rs bench + README), 05-02-PLAN.md (agent shell) vs ROADMAP Phase 5 SCs, 05-CONTEXT.md, 05-RESEARCH.md, and current `src/index.ts`, `src/typecheck/*`, `src/sandbox/runtime.ts`, `src/agent/{mock,loop}.ts`, `scripts/test-*-live.mjs`, `test/*.spec.ts`, `package.json`, `README.md`.

## Checks

| # | Check | Result |
|---|-------|--------|
| 1 | Coverage: all 5 requirement IDs + SC 1–5 | PASS |
| 2 | tsc-rs integration soundness | PASS with 1 blocking count bug (B1) |
| 3 | Shell soundness | PASS |
| 4 | Executability (verbatim contents, hand-traced greps, harness realism, teardown) | FAIL — 2 blocking (B2, B3) |
| 5 | Frontmatter validity, files_modified, waves | PASS |

**Coverage detail (check 1):** 05-01 frontmatter carries [TSCRS-01, TSCRS-02], 05-02 carries [SHELL-01, SHELL-02, SHELL-03] — all 5 roadmap IDs, disjoint, no gaps. SC-1→05-01 T1 (5 locked snippets, both legs, table) + T2 (README commit); SC-2→05-01 T2 "Why this exists"; SC-3→05-02 T1/T2 + live happy session; SC-4→05-02 T1 guardrails-by-construction + T4 gates; SC-5→05-02 T4 full chain (vitest 41 ≥ 27, 4 harnesses).

**tsc-rs detail (check 2):** exact pin `0.2.0` devDep; never-bundle gates present (`grep -rn "tsc-rs" src/` → 0, `dist-bundle/` → 0); JS-API invocation matches research exactly (`new API({fs: createVirtualFileSystem(...)})`, ambient globals as explicit rootName, numeric mirrored options 9/99/100 = host.ts `GUEST_COMPILER_OPTIONS`, getter-dispose discipline, `DiagnosticCategory.Error` filter); snippet set matches `src/agent/mock.ts` turns byte-for-byte (iter1/final slugify + fibonacci turn 3) and `test-typecheck-live.mjs` LIB_GUEST; expected 2/0/0/0/0 asserted on the native leg; `runs: 6` gives 1 cold + 5 warm; detached-process-group boot + `fuser` backstop teardown; machineLine emits `process.platform process.arch` (arm64 honesty) + committed "Machine: linux" grep.

**Shell detail (check 3):** `src/shell/shell.ts` has exactly 3 `import type` lines, zero runtime imports (vitest-transport safe); deps injected (typechecker/sandbox/transpile — no static typescript import); caps coherent (32 commands → 400; 1 MiB seed → 400, write → op-fail `vfs_full` without mutation; 20 KiB sandbox gate inherited not duplicated); `stopOnError`/`haltedAt` semantics coherent (`results.length === haltedAt + 1`); handler wires the same per-request primitives as `/agent/run`; no eval path; KNOWN_PATHS + case wiring is additive with Phase 1–4 anchors verified verbatim-present in `src/index.ts`; 400-vs-op-level boundary deviation from research (unknown op → `ok:false`) is explicitly documented in "Pinned deltas"; response-shape deltas (`haltedAt`, no `index`/`totalMs`) documented and consistent across plan, spec, harness, and README contract row.

## Issues (blocking)

1. **05-02 T3 — error-session run assertion is factually wrong: iter1 passes 2/2 in the sandbox, not 1/2.** The harness asserts `br[2].result.sandbox.tests.filter((t) => t.passed === true).length === 1` ("the type-broken guest still runs 1/2 tests"). SLUGIFY_ITER1's planted defect is *type-only*; `transpileGuest` erases types and the JS logic (both regex replaces) is identical to the passing final — `slugify("  A -- B  ")` → `"a-b"` — so both tests pass in QuickJS. Cross-check: the 1-failed/1-passed behavior belongs to mock **iteration 2** (type-fixed, logic-broken, pinned by test-agent-live.mjs lines 176–185), and iter2's typecheck op would *pass*, so it cannot be substituted into this session. The live harness will FAIL on a correct implementation. **Fix:** assert `=== 2` with an honest label (e.g. "types are erased in the sandbox — the type-broken guest's logic still passes 2/2"), or drop the count and assert `sandbox.status === "ok" && sandbox.tests.length === 2`.

2. **05-01 T2 — three README count criteria ignore the pasted footnotes.** The action mandates pasting "the footnote list" between the BEGIN/END markers; footnote 5 contains "host-side", "Typechecker", and "WASM build". So on a correctly executed plan: `grep -ci "host-side"` = **3** (Why-table row + Benchmark prose + footnote 5), not 2; `grep -c "Typechecker"` = **3** (seam row + honest reading + footnote 5), not 2; `grep -ci "wasm build"` = **4** (Type-checker row + seam row + honest reading + footnote 5), not 3. All three acceptance bullets fail as written. **Fix:** update the three criteria to exactly 3 / 3 / 4 (cleaner than excluding footnote 5 from the paste, since footnote 3's lib-closure note is research-mandated for the README table).

3. **05-02 T4 — teardown-line count is wrong: a green `test:live` log has 6, not 8.** The criterion `grep -c "teardown: wrangler killed and port closed" → 8 (2 per harness x 4)` miscounts twice: (a) the two print sites are **if/else-exclusive** — `assert(false, ...)` fires only when teardown *failed* (which also fails the harness), so a green run prints exactly one `ok -` line per `killWrangler` call; (b) the harnesses do not boot one wrangler each — test-typecheck-live boots 1, test-sandbox-live 1, **test-agent-live boots 3** (wranglers A/B/C, lines 302/339/397), the new shell harness 1 → **6** lines green. The gate fails despite a fully green chain. **Fix:** expect exactly 6 with per-harness attribution (1+1+3+1).

## Suggestions (non-blocking)

- 05-01 T1: `grep -c "createProgram" → 3` is correct, but the attribution "header comment + cold + warm" is off — the third occurrence is footnote 1 ("createProgram+diagnostics"), not the header comment. Same for the "runs: 6 → 3" attribution ("README footnote line" is actually the docs/benchmarks.md footnote emitted by the script).
- 05-01: the scripted `synthetic-100` builds ~90 lines / ~2.5 KB, not the research probe's 133 lines / 5913 B. No gate depends on the size; either adjust the "~100-line" comment or note the drift from the research table.
- 05-01 bench: the in-isolate leg asserts per-run `ok` flags (equivalent to ≥1 error), while the tsc-rs leg asserts exact counts. Equivalent on this snippet set; worth one explicit sentence so the "regression net" claim isn't over-read.
- TSCRS-*/SHELL-* exist only in ROADMAP (milestone v2), not REQUIREMENTS.md (v1's 21). Fine for now; formalize there if v2 requirements are ever inventoried.
- 05-02 T2's "verified live during planning" note is unverifiable by the executor; the greps stand on their own, so it's harmless but removable.
