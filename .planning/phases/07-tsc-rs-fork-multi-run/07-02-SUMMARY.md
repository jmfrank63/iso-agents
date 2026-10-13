# Plan 07-02 Execution Summary

**Phase:** 07-tsc-rs-fork-multi-run | **Plan:** 07-02 (wave 2) | **Executed:** 2026-10-13
**Executor:** gsd-executor | **Status:** DELIVERED — all tasks complete, full gate chain green in BOTH TSCHECKER modes

## Outcome

FORK-03 flipped from seam to observable, proven, measured behavior: `/typecheck` responses from
the wasm checker now carry the optional `held` block (ts-js byte-identical to Phase 6 — the
field is simply absent), `TSCHECKER_WASM_RECYCLE_AFTER` is a declared Env var, the wasm live
harness proves reuse + scheduled recycle + recycle-on-error over real workerd in two boots, the
bench splits its wasm leg into asserted fresh-vs-held legs with REAL numbers committed to
docs/benchmarks.md + README, and FORK-01..03 are Done in REQUIREMENTS.md. Nothing in
`src/typecheck-wasm/*` changed this wave (must-have 6); the artifact sha is unchanged.

## Per-task notes

### T1 — Worker wiring: Env field + /typecheck held stats — DONE (commit 8dbaffd)
- Three exact replacements applied to `src/index.ts`: (1a) Env field
  `TSCHECKER_WASM_RECYCLE_AFTER?: string` with the FORK-02 comment; (1b) `const held =
  checker.heldStats?.();` after the run loop with the FORK-03 observability comment; (1c)
  response data spread `...(held === undefined ? {} : { held })`.
- Gates: `npm run check` exit 0; greps — TSCHECKER_WASM_RECYCLE_AFTER=2, checker.heldStats?.()=1,
  `held === undefined ? {} : { held }`=1, FORK-03 observability=1, recycles=0. All exactly as planned.

### T2 — Live harness rewrite (two boots) — DONE (commit 0045e23)
- `scripts/test-typecheck-wasm-live.mjs` rewritten with the plan's EXACT verbatim content
  (legA default held boot + legB `TSCHECKER_WASM_RECYCLE_AFTER:2` boot).
- `node --check` OK. **Live run: exit 0 with 47 ok lines — 37 A-leg asserts + 1 A teardown +
  8 B-leg asserts + 1 B teardown — matching the plan's hand-trace exactly.**
- Observed reuse/recycle proofs (all asserts passed; detail values print only on failure, so
  exact ms not captured): A-leg — 3 runs in one request all on `instanceGen` 1 / recycles 0 /
  runsOnInstance 3; second request on the SAME gen with runsOnInstance 4; `results[1].ms <
  results[0].ms` (warm < first). B-leg — gen 1 runs 1-2, **gen 1 → 2 exactly at run 3 with
  recycles 1**; deep-nested (20,000-deep) guest → HTTP 500 + `ok:false`; next green check
  correct on **gen 3 with recycles 2**; identity stable across recycles.
- A-leg fixture parity held: TS2322 @1:7 (RED), 2 diags @2:9 (iter1), clean final (stale-parse
  control), lib-heavy clean; agent loop converged in 3 iterations; memory smoke: 10 alternating
  runs, gen 1 throughout, memory bounded < 100 MB, no post-warmup growth (last <= run-3
  sample + 2 MB); identity flip to `ts-rust@multi-run/c1b8218 (wasm)`.
- Plan-arithmetic notes (content verbatim; hand-traces undercounted lines inside the plan's own
  blocks): `TSCHECKER_WASM_RECYCLE_AFTER` = **4** not 3 (missed the final
  `console.log("leg B/2: TSCHECKER_WASM_RECYCLE_AFTER=2 boot ...")` line); `instanceGen` =
  **11** not 8 (missed the two header bullets "instanceGen stable…" / "instanceGen 1 -> 2…" and
  the A-leg reuse comment "instanceGen stable, runsOnInstance"). All other greps matched: legs=2,
  fork-qualified id=4, 569df52=0, stale-parse=3, runsOnInstance === 4=1, DEEP_NESTED_GUEST=2.

### T3 — Bench fresh-vs-held + real numbers committed — DONE (commit b48b551)
- Emitter edits 3a-3e applied exactly: leg 3 → FRESH boot (`TSCHECKER_WASM_RECYCLE_AFTER:1`)
  with the cumulative fresh-semantics assert (snippet k at gen 6k / recycles 6k-1,
  `runsOnInstance === 1`); new leg 4 HELD boot (default; `instanceGen === 1`, recycles 0);
  11-column table; fork machine line; rewritten wasm footnotes (+5,150,781 size, fresh/held
  protocol); THREE-workers doc header.
- **Real run #1: exit 0, 63 ok lines** (5 native + 15 ts-js + 1 teardown + 20 wasm-fresh
  [5 snippets × 4 asserts] + 1 teardown + 20 wasm-held + 1 teardown). Cumulative fresh-leg
  asserts observed: gen 6/12/18/24/30, recycles 5/11/17/23/29 — final gen 30 / recycles 29.
  Held-leg asserts observed: gen 1 / recycles 0 across all 30 runs.
- Sanity vs 07-RESEARCH: fresh first cold 567.0 ms (band ~500-540, within 2x); held warm
  medians 96.0/82.0/80.0/77.0/78.0 ms (band 70-125); **held warm < fresh warm on every
  snippet** (96<179, 82<160, 80<151, 77<165, 78<154). No column flagged.
- Table + spawn line + machine line + footnotes pasted verbatim into README between the
  BEGIN/END BENCH TABLE markers (markers intact). **Re-run after the paste: exit 0**
  ("bench complete"). README greps: 569df52=3 (prose row + pasted machine line + pasted fork
  footnote, per the plan's corrected hand-trace), `ts-rust@569df52 (wasm)`=0,
  `ts-rust@multi-run/c1b8218 (wasm)`=1.
- Emitter grep notes: TSCHECKER_WASM_RECYCLE_AFTER = **8** not 5 (the plan's trace missed the
  3b assert-comment, the 3d `const c = wasm[i]` row comment, and the 3e doc-header line — all
  inside its own verbatim blocks); leg 3/4|4/4=4, wasmHeld=3, expectedGen=3,
  `instanceGen === 1`=1, 5,150,781=1, 5,125,434=0 — all as planned.
- Inherent drift note: the re-run regenerates docs/benchmarks.md (timestamps/numbers vary a few
  percent between runs); README holds run-1's numbers, docs holds the final re-run's. Both are
  real runs; every run stayed inside the research bands. This paste-then-rerun drift is the
  plan's own procedure and the same pattern 07-01 recorded as pre-existing.

### T4 — Full gate chain + REQUIREMENTS flip — DONE (no commit: both files live under `.planning/`)
- Gate chain run in order, all green (below). REQUIREMENTS.md: three traceability rows Planned →
  Done; three v4 checkboxes `[ ]` → `[x]` (verified: `| FORK-0` rows=3, FORK-01 Done row=1,
  `[x] **FORK-0`=3, remaining `[ ] **FORK-0`=0). 07-02-SUMMARY.md (this file) created.

## Files + commits

| Task | Files | Commit |
|---|---|---|
| T1 | `src/index.ts` | `8dbaffd` |
| T2 | `scripts/test-typecheck-wasm-live.mjs` (full rewrite) | `0045e23` |
| T3 | `scripts/bench-tsc-rs.mjs`, `docs/benchmarks.md` (run-generated), `README.md` | `b48b551` |
| T4 | `.planning/REQUIREMENTS.md`, `.planning/phases/07-tsc-rs-fork-multi-run/07-02-SUMMARY.md` | none (rule: never commit `.planning/`) |

Not committed (pre-existing): the untracked `07-01-SUMMARY.md` (rule); the pre-existing
`docs/benchmarks.md` working-tree diff from 07-01's era was absorbed by this wave's real bench
regeneration.

## Gate results (both modes)

| # | Gate | Result |
|---|---|---|
| 1 | `npm run check` | exit 0 (tsc clean) |
| 2 | `npx vitest run` | **Test Files 7 passed (7) / Tests 64 passed (64)** — unchanged from 07-01, as planned |
| 3 | `npm run gate:no-host-eval` | pass (no eval/new Function in src/) |
| 4 | `npm run bundle:check` | exit 0; `dist-bundle/*.wasm \| wc -l` = **2** (quickjs 503,134 B + ts_rust **5,150,781 B**); dry-run bundle 16,917.81 KiB / gzip 4,197.88 KiB |
| 5 | `npm run bench:tsc-rs` | exit 0, FOUR legs, **63 ok assertions** (fresh-leg cumulative asserts gen 6→30 incl.; held-leg gen-1/recycles-0 asserts incl.); docs/benchmarks.md regenerated |
| 6 | `npm run test:live` | exit 0, **FIVE harnesses green, 236 ok lines total, 0 FAILs**: typecheck ts-js 41, sandbox 40, agent 54, shell 54, **typecheck-wasm 47 (A-leg 37+1 teardown, B-leg 8+1 teardown)** |

**Mode coverage:** ts-js mode proven by the four untouched default harnesses (171 ok lines;
`held` absent from their responses by the optional chain); tsc-rs-wasm mode proven by the wasm
harness's two boots (default held + RECYCLE_AFTER:2) and the bench's two wasm boots
(RECYCLE_AFTER:1 fresh + default held).

## Reuse proof + recycle boundary (observed, from the T2 live run)

- **Reuse (Leg A, default boot):** request 1 = 3 runs on `instanceGen` 1 (recycles 0,
  runsOnInstance 3); request 2 lands on the SAME gen 1 with runsOnInstance 4;
  `results[1].ms < results[0].ms` (assert held; exact ms not emitted on pass).
- **Scheduled recycle (Leg B, threshold 2):** runs 1-2 on gen 1 (runsOnInstance 1, then 2);
  **run 3 → gen 2, runsOnInstance 1, recycles 1**, verdict still correct.
- **Recycle-on-error (Leg B):** 20,000-deep nested object type → **HTTP 500 + ok:false**; the
  NEXT green check is `ok:true` on **gen 3, recycles 2** — 07-RESEARCH's flow, over HTTP.
- **Memory smoke (Leg A):** 10 alternating guests, gen 1 / recycles 0 throughout, memoryBytes
  < 100 MB and last <= run-3 sample + 2 MB.
- **Bench cumulative fresh leg:** snippet k ends at gen 6k / recycles 6k-1 — observed
  6/5, 12/11, 18/17, 24/23, **30/29** with `runsOnInstance === 1` per request.

## Bench headline (fresh vs held vs ts-js vs native — real run, 2026-10-13)

| snippet | wasm fresh cold | wasm fresh warm med(5) | wasm held cold | wasm held warm med(5) | ts-js warm med(5) | tsc-rs native warm med(10) |
|---|---|---|---|---|---|---|
| slugify-iter1    | 567.0 | 179.0 | 598.0 | **96.0** | 7.0  | 31.3 |
| slugify-final    | 164.0 | 160.0 | 91.0  | **82.0** | 6.0  | 31.4 |
| fibonacci-final  | 167.0 | 151.0 | 90.0  | **80.0** | 5.0  | 30.1 |
| lib-heavy        | 181.0 | 165.0 | 87.0  | **77.0** | 13.0 | 29.8 |
| synthetic-100    | 160.0 | 154.0 | 83.0  | **78.0** | 15.0 | 30.8 |

Held warm beats fresh warm on every snippet (1.9-2.1x): the mtime-keyed parse cache is the
whole story. ts-js remains fastest warm on these tiny guests; the held wasm checker is now
within ~65-85 ms of it rather than ~145-170 ms.

## Deviations

1. **Plan grep hand-trace miscounts** (content always written EXACTLY as prescribed; corrected
   counts recorded above): harness TSCHECKER_WASM_RECYCLE_AFTER 4 vs 3; harness instanceGen
   11 vs 8; bench emitter TSCHECKER_WASM_RECYCLE_AFTER 8 vs 5. Same pattern as 07-01 — the
   verbatim blocks govern.
2. **T4 has no commit** — both its files live under `.planning/`, which the executor rules
   forbid committing (same as 07-01 T5).
3. **README↔docs number drift after the prescribed post-paste re-run** — inherent to the plan's
   own paste-then-rerun procedure; both number sets are real runs inside the research bands.
4. **`/tmp/opencode` not writable in this environment** (owned by another user) — run logs kept
   under `/tmp/t3scratch/`; no repo impact. Also `wrangler` is not on PATH here, so all
   harness/bench invocations ran with `node_modules/.bin` prepended to PATH (the harnesses'
   `spawn("wrangler", ...)` resolved via PATH; no script changes).

## Requirements flipped

FORK-01, FORK-02, FORK-03 → **Done** (traceability rows + Milestone v4 checkboxes).
