# Plan 07-01 Execution Summary

**Phase:** 07-tsc-rs-fork-multi-run | **Plan:** 07-01 (wave 1) | **Executed:** 2026-10-13
**Executor:** gsd-executor | **Status:** DELIVERED — all tasks complete, all gates green

## Outcome

The multi-run fork artifact is the committed checker binary; provenance doc rewritten; the host
side moved from fresh-instance-per-check to ONE HELD INSTANCE PER ISOLATE with mtime-stamped
memfs, scheduled + throw recycling, fork-qualified identity, and the held-stats seam for 07-02.
Default (ts-js) mode untouched; no wrangler boots performed (test:live explicitly excluded —
old identity strings live until 07-02).

## Per-task notes

### T1 — Artifact swap + fork provenance doc — DONE (commit c34b800)
- Source artifact verified BEFORE copy: `/tmp/tsrust-spike/ts-rust/npm/wasm/ts_rust.wasm`,
  5,150,781 bytes, sha256 `9cd244ef87da4b399e9b7c408a68e0342b24569d6d126cda3599d0f19b878d06`.
- Post-copy: size `5150781`, sha256 match (grep count 1).
- ABI-freeze node check printed: `ABI frozen: import/export surface identical to pin 569df52`.
- `docs/ts-rust-wasm.md` rewritten verbatim per plan. Doc grep gates: c1b8218339d0=4,
  sha=1, 5,150,781=2, 5,125,434=2, 62,521,344=2, +327/-11=2, install_program_version=2,
  TSCHECKER_WASM_RECYCLE_AFTER=2, MultiRunHost=2, "Fresh instance per check"=0,
  "HELD instance per isolate"=1, wasm-opt MUST be on PATH=1.
- Plan-arithmetic note: acceptance criterion said `grep -c "multi-run"` = 6, actual **8** —
  the plan's own verbatim content block contains two more occurrences it did not count
  ("the new multi-run test" in the fork-validation paragraph; "includes the multi-run test"
  in rebuild step 5). Content was written EXACTLY as prescribed; the verbatim block governs.

### T2 — memfs monotonic mtime stamping + spec — DONE (commit 7a46071)
- Header reframed; `tick`/`stamps` state added; `stat` spreads `mtimeNs` when stamped;
  `writeFile` stamps `++tick`; `remove` clears stamps. Constructor-seeded files byte-identically
  unstamped (existing 6 memfs specs still green, incl. `toEqual({ isDirectory: false, size: 20, mtimeMs: 0 })`).
- 4 new spec tests appended verbatim; `npx vitest run test/typecheck-wasm-mapping.spec.ts`
  → **15 passed (11 + 4)**. memfs still ZERO imports (`grep -c "^import"` = 0). stamps=6, tick=2,
  `1n`=1, `3n`=1.
- Plan-arithmetic note: `mtimeNs` in memfs.ts = **4** (plan said 3) — the plan's hand-trace
  missed the PRE-EXISTING `chtimes?(path, atimeNs?, mtimeNs?)` signature line; spec = **7**
  (plan said 5) — the hand-trace missed the two `it(...)` test titles containing `mtimeNs`,
  both inside the plan's own verbatim block. Content exact; counts corrected here.

### T3 — Shim held-instance runtime — DONE (commit 5fb094d)
- Header rewritten (two-path rationale: runTsc legacy / runTscHeld); `TS_RUST_PIN` →
  `TS_RUST_BASE_PIN`/`TS_RUST_FORK_BRANCH`/`TS_RUST_FORK_COMMIT` (0/1/4/4 occurrences);
  all three shape-assert messages fork-qualified; `start()` resets `stderrText` per ts_run;
  `runTsc` doc comment updated, body untouched.
- Held section appended verbatim: `RECYCLE_AFTER_RUNS = 50`, module-level held state,
  `HeldRunStats`/`heldRunStats()`, `dropHeldInstance()` (env-change + scheduled + catch),
  `syncHeldFiles` (re-stamp changed, remove absent), `runTscHeld` (cwd hard-asserted "/",
  env-key pinning, recycle-on-ANY-throw with exit-semantics comments at header + catch).
- Gate results: dropHeldInstance=4, RECYCLE_AFTER_RUNS=3 (plan said 2), syncHeldFiles=2,
  heldRunStats=1, HeldRunStats=2, HeldRunResult=2, heldStdoutChunks=4, heldGen=5 (plan said 4),
  new WebAssembly.Instance=3, stderrText=4, "diagnostics found, NOT an error"=2, runTsc(=1,
  "first run's cwd"=1.
- Plan-arithmetic notes: runTscHeld=**7** (plan 5 — hand-trace missed the 3d assert-comment
  "runTsc/runTscHeld" and the 3f sinks comment, both prescribed), RECYCLE_AFTER_RUNS=**3**
  (plan 2 — header comment occurrence prescribed by 3a), heldGen=**5** (plan 4 — the
  `recycles: Math.max(heldGen - 1, 0)` line in the prescribed code).
- **Deviation (cross-task coupling):** T3's `npm run check` gate FAILED at T3-commit time —
  `checker.ts` still imported the renamed `TS_RUST_PIN` (T4's file). The plan overlooked this
  dependency. Resolution: T3 committed with shim.ts only; `npm run check` re-verified GREEN at
  T4 (19a7a7f). The intermediate T3 commit does not compile standalone; the working tree was
  never left broken.

### T4 — Checker + selection + factory + heldStats seam — DONE (commit 19a7a7f)
- `checker.ts` rewritten with EXACT planned content: runTscHeld call, identity
  `ts-rust@${TS_RUST_FORK_BRANCH}/${TS_RUST_FORK_COMMIT.slice(0, 7)} (wasm)`, optional
  `recycleAfter` ctor param, `heldStats()` → `heldRunStats()`. `runTsc\b` count = 0.
- `selection.ts`: `parseTSCheckerWasmRecycleAfter` appended (count 1).
- `index.ts`: `TypecheckerHeldStats` interface + OPTIONAL `heldStats?()` on the seam;
  import widened; seam comment fork-qualified (569df52=1, c1b8218339d0=1 — the plan's own
  corrected counts); factory widened to accept `TSCHECKER_WASM_RECYCLE_AFTER` and passes
  `parseTSCheckerWasmRecycleAfter(env)` (RECYCLE literal count = 1, matching the corrected verify).
- Plan-arithmetic note: plan action (4e)'s oldString started mid-line; the actual first line
  carries the `// (the Phase 2 seam proof), and ` prefix — edit applied against the true text,
  replacement content exactly as prescribed.
- Gates: checker counts runTscHeld=2, heldRunStats=2, TypecheckerHeldStats=2, FORK_BRANCH=2,
  FORK_COMMIT=2, recycleAfter=2, id-template=1, heldStats=1; selection spec → **8 passed
  (5+3)**; full suite → **Test Files 7 passed (7) / Tests 64 passed (64)** (57 + 4 + 3, as planned).

### T5 — Register FORK-01..03 — DONE, edits uncommitted per rules
- Milestone v4 section inserted after WASM-05 (before `## Out of Scope`) with the three FORK
  bullets verbatim; traceability rows FORK-01/02/03 → "Phase 7 — tsc-rs fork: multi-run held
  instances | Planned" inserted after the WASM-05 row.
- Gates: FORK-0=6, Milestone v4 Requirements=1, multi-run/c1b8218=1,
  "diagnostics found, NOT an error"=1.
- **No commit:** the plan's only T5 file is `.planning/REQUIREMENTS.md`, and the executor rules
  forbid committing `.planning/`. Edits are in the working tree (07-02 flips Planned → Done).

## Files + commits

| Task | Files | Commit |
|---|---|---|
| T1 | `src/typecheck-wasm/ts_rust.wasm` (5,150,781 B, sha256 `9cd244ef87da4b399e9b7c408a68e0342b24569d6d126cda3599d0f19b878d06`), `docs/ts-rust-wasm.md` | `c34b800` |
| T2 | `src/typecheck-wasm/memfs.ts`, `test/typecheck-wasm-mapping.spec.ts` | `7a46071` |
| T3 | `src/typecheck-wasm/shim.ts` | `5fb094d` |
| T4 | `src/typecheck-wasm/checker.ts`, `src/typecheck/selection.ts`, `src/typecheck/index.ts`, `test/typecheck-selection.spec.ts` | `19a7a7f` |
| T5 | `.planning/REQUIREMENTS.md` | none (rule: never commit `.planning/`) |

Not committed (pre-existing, out of plan scope): `docs/benchmarks.md` working-tree diff from an
earlier bench re-run (timestamps/numbers only, predates this execution).

## Gate results

| Gate | Result |
|---|---|
| Artifact size | `5150781` (expected exact) |
| Artifact sha256 | `9cd244ef87da4b399e9b7c408a68e0342b24569d6d126cda3599d0f19b878d06` (verified at source BEFORE copy) |
| ABI freeze (node import/export check) | `ABI frozen: import/export surface identical to pin 569df52` |
| `npm run check` | exit 0 (green from T4 onward; see T3 deviation) |
| `npx vitest run` | **Test Files 7 passed (7) / Tests 64 passed (64)** — 57 pre-existing + 4 memfs stamps + 3 recycle-parse |
| `npm run gate:no-host-eval` | pass (no eval/new Function in src/) |
| `npm run bundle:check` | dry-run clean; `dist-bundle/*.wasm | wc -l` = **2** (quickjs 503,134 B + ts_rust 5,150,781 B); stale pre-plan ts_rust.wasm build output removed from the gitignored dist dir for an honest count |
| `npm run test:live` | NOT run — explicitly excluded this wave (wasm harness still asserts `ts-rust@569df52 (wasm)`; rewired in 07-02) |
| wrangler boots | none |

## Deviations (all minor, none behavioral)

1. **T3 check gate timing** — `npm run check` could not pass until T4 rewrote `checker.ts` off
   the renamed constant (plan cross-task coupling). Check verified green at T4; the T3 commit
   is not standalone-compilable.
2. **Plan grep hand-trace miscounts** (content always written EXACTLY as prescribed; corrected
   counts recorded): multi-run doc 8 vs 6; memfs mtimeNs 4 vs 3 (pre-existing chtimes line);
   spec mtimeNs 7 vs 5 (two `it` titles); shim runTscHeld 7 vs 5; RECYCLE_AFTER_RUNS 3 vs 2;
   heldGen 5 vs 4 (recycles line).
3. **T5 has no commit** — its only file lives under `.planning/`, which the executor rules
   forbid committing.
4. **dist-bundle cleanup** — removed a stale pre-plan `ts_rust.wasm` build output (old pin,
   5,125,434 B) from the gitignored `dist-bundle/` so the `wc -l` gate reads 2; not a repo edit.
