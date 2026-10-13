# Plan 04-01 Summary: Agent loop core (wave 1)

**Status:** COMPLETE — all 4 tasks executed in order, all gates green, no deviations from verbatim content.

## Per-task notes

### T1 — LLM provider seam (`src/agent/provider.ts`)
- Created verbatim from plan: `LlmProvider`/`LlmMessage`/`LlmCompletion`/`LlmError` seam, `createLlmProvider` factory (mock default, openai opt-in with misconfig throw, unknown-kind throw), `getAgentIdentity` for healthz, `OpenAiCompatibleLlmProvider` with retry-once on retryable failures, `err.name` classification (G7), `AbortSignal.timeout`, 500-char error-body cap.
- **Note:** T1's `npm run check` could not exit 0 in isolation — the verbatim provider imports `./mock` at the bottom (created in T2), by plan design. All greps passed at T1; check went green immediately after T2. No content change made.

### T2 — Extractor + mock (`src/agent/extractor.ts`, `src/agent/mock.ts`)
- Extractor verbatim: fence strip → JSON.parse → brace salvage → shape validation → script-style gate (`\b(?:import|export)\b`) with `MalformedContractError` / `ScriptViolationError`.
- Mock verbatim: SLUGIFY + FIBONACCI 3-turn planted progressions, (task,spec) sniff selection, per-instance call counter, clean JSON always. Planted bugs confirmed present (`const slug: number`, `i < n` — each grep-count 2 as planned).

### T3 — Loop + transpile + typecheck surface
- `src/agent/loop.ts` verbatim: 5 `import type` seams + exactly 1 runtime import (extractor) — WS-1009 discipline holds; full CORE-02 pipeline with CORE-03 typecheck gate, single-file gate, transpile tripwire, test-less-guest guard, CONTEXT windowing (last 3), one-shot corrective retry (G9 exact wording), script-violation heal-via-feedback (G3), all five terminal statuses.
- `src/typecheck/transpile.ts` verbatim: conservative `{ target: ES2022, isolatedModules: true }`.
- `src/typecheck/index.ts`: `mapDiagnostic` exported with the planned 2-line comment (only change).
- `src/typecheck/vfs.ts`: `GUEST_GLOBALS_TEXT` extended to the Phase 3 harness surface (console + test/assert + Expectation{toEqual,toBeTrue,toBeCloseTo} + expect) — the discovered convergence enabler; only Phase 2+ snippets unaffected per plan review spot-compile.

### T4 — Registry + specs
- `src/runs.ts` rewritten verbatim: CONTEXT record shape, `create(task)`/`get`/`finalize`, `MAX_STORED_RUNS = 50` FIFO (insertion-order eviction, get() does not refresh), `"running" | AgentStatus` composition (G1 — no `"deadline"` literal).
- `test/runs.spec.ts`: 2 existing tests migrated + finalize + FIFO cap = 4 tests.
- `test/agent-pure.spec.ts`: 6 tests (4 extractor + 2 mock determinism/convergence).
- `test/loop.spec.ts`: 7 tests — all five terminal statuses + CORE-03 gate + test-less-guest path; stub seams only, type-only imports of typecheck/sandbox/transpile (erased at runtime). Timing assert uses `toBeGreaterThanOrEqual(0)` per the plan-review coarse-clock finding (rev 1 already incorporated).

## Files + commits

| Commit | Files |
|---|---|
| `3c5b19b` feat(04-01): LLM provider seam (T1) | src/agent/provider.ts |
| `31eafa5` feat(04-01): extractor + mock (T2) | src/agent/extractor.ts, src/agent/mock.ts |
| `7741f1c` feat(04-01): loop + transpile + typecheck surface (T3) | src/agent/loop.ts, src/typecheck/transpile.ts, src/typecheck/index.ts, src/typecheck/vfs.ts |
| `03e6d7f` feat(04-01): registry growth + unit specs (T4) | src/runs.ts, test/runs.spec.ts, test/agent-pure.spec.ts, test/loop.spec.ts |

No new npm dependencies; package.json untouched. `src/index.ts`, `scripts/`, wrangler config, and existing live harnesses untouched (04-02 wires them).

## Gate results

| Gate | Result |
|---|---|
| `npm run check` | exit 0 (after T2 onward; T1-only failure was the planned cross-task `./mock` import) |
| `npx vitest run` | **Test Files 4 passed (4), Tests 27 passed (27)** — 12 existing + 15 new, exactly as planned |
| `npm run gate:no-host-eval` | pass (no eval/new Function in src/) |
| Baseline before start | 2 files / 12 tests passing (confirmed) |
| T3 checkpoint vitest | 2 files / 12 tests still green before T4 specs landed |

All per-task grep acceptance criteria verified with exact counts (provider, extractor, mock, loop, transpile, vfs, runs, both new specs).

## Deviations

- None in content (all verbatim blocks lifted exactly).
- Sequencing note (T1): `npm run check` exits 0 only from T2 onward because the verbatim provider.ts imports `./mock` (T2's file). T1 commits were made in plan order; the tree type-checks at every commit from `31eafa5` onward.
- `test:live` intentionally NOT run per plan (04-02 wires the routes).
