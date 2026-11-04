# Phase 10: rebase onto 91f3d021c (949 upstream commits) | **Researched:** 2026-10-14, executed 2026-11-04

## Verdict

**REBASED: yes | COMMITS: 9 (8 ports + 1 new remediation; the empty `d7f40d123` mergeability nudge was dropped) | CONFLICTS RESOLVED: 2 (1 textual, 1 semantic — details below; all other hunks auto-merged) | GATES green (fmt, clippy ×5 crates, ts_wasm tests 11/11, wasm-tests job 1/1) | PUSHED yes (`--force-with-lease`, PR #85 flipped CONFLICTING→CLEAN/MERGEABLE at `6281c42f4`)**

New `multi-run` head: `6281c42f48963fd4453f6a317cc1f235702b9f7c`, 9 commits on top of upstream `91f3d021c`. Cumulative fork footprint vs new upstream: 6 files, +1503/−20 (`multirun.rs` +816, `ts_wasm/lib.rs` +611, `execute_tsc.rs` 41, `host.rs` 35, `program.rs` 9, `npm/wasm/core.js` 11).

## Conflict log

| # | Commit (new hash) | Files | Resolution strategy / upstream APIs re-anchored |
|---|---|---|---|
| 1 | `71d4c186e` wasm: one instance serves many tsc runs | `ts_wasm/lib.rs` (only file; `program.rs`, `execute_tsc.rs`, `host.rs` auto-merged) | One 4-line doc-comment conflict above `mod tests`: upstream renamed it for its new `wasm_tests` module (PR #82), fork had rewritten it for its native test suite. Merged both intents: fork's "tests run over `host::test_host`" wording + upstream's "`wasm_tests`" pointer. **Semantic re-anchoring verified, no conflict:** `new_frontend_program` now returns `Rc<NewProgram>` and `new_program_version` now takes `&Rc<NewProgram>` — mutually consistent, so the fork's `install_and_enter` compiled unchanged; `mark_freeable_parses(&np)` derefs the `Rc`. Upstream's `ModeAwareCache<T>` = `FxHashMap` alias, so `influenced_by`'s iteration (`resolved_modules`/`type_resolutions_in_file` now `Arc`/`Rc`-wrapped) needed no edit. `release_program(&'static GoProgram)` unchanged. |
| 2–8 | `ebbdb7c4b`, `f6bc80cf0`, `cd00fdc52`, `efd5d29fb`, `a6a1d3ed4`, `ecb2d4e0a`, `9f75ebf75` | — | Applied cleanly (fork-new `multirun.rs` + hunks in lib.rs regions upstream didn't touch). |
| 9 | `6281c42f4` **new commit** multirun: adapt upstream's wasm release_checker test | `program/multirun.rs` (+14), `ts_wasm/lib.rs` (+7) | **Semantic conflict found at runtime, not by git:** upstream's new CI `wasm` job (`wasm_tests::release_checker_frees_the_checker`, PR #82) panicked — `release_checker` calls `prog()`, but the multi-run flow leaves no current program between runs. Fix preserves upstream API semantics (no `try_prog()` weakening): the test enters the run's version via a new `#[doc(hidden)] multirun::enter_last_version() -> Option<ProgramScope>` hook (same pattern as `take_parse_cache_counts`); test intent intact (release frees now; double/bad release no-op). Documented that an embedder freeing checkers between runs must hold this scope. |

## Feature survival check (all 7)

1. **Multi-run flow** — yes. `register_program_version` / `enter_program(None → ProgramScope)` / `release_program` all survive at 91f3d021c with compatible semantics (`core.rs:4875-4913`); `install_program` returns `Option<ProgramScope>` and is held across compile in both `perform_compilation` and `perform_incremental_compilation`. Evidence: `many_runs_in_one_process_report_each_guest` passes; probe steps 1–6 on one held instance.
2. **Parse cache (content-hash keyed, eviction, freeable first parses, libs exempt)** — yes. All ast/file_version APIs survive (`set_watch_process`, `note_published_path`, `freeable_path`, `FileVersion`, `is_published`); `ParsedSourceFile` fields (`store`, `version: OnceCell`, `parse_options()`, `external_module_indicator`, …) unchanged. Evidence: `parse_cache_reuses_parses_across_runs` (counter test) + `a_path_that_returns_with_other_content_rereports` pass; eviction bounded in the soak (below).
3. **Semantic-diag reuse + fingerprint replay** — yes. `get_semantic_diagnostics(source_file: Node)` hook point survives verbatim (`program.rs:5366`), and the whole-program fan-out still reaches it through `ProgramLike` (`execute/tsc/emit.rs:69,222`) with NIL for the whole program. Evidence: `script_body_change_rereports_and_shape_change_rechecks` and `identical_request_over_a_changed_guest_rereports` pass; probe replay-hit (step 7) and replay-miss (step 8).
4. **Guards** — yes. cwd rejection, case-flag rejection, INSTALLED_RUN early-return rotation guard all in the rebased lib.rs/multirun.rs. Evidence: `cwd_change_is_rejected`, `case_flag_change_is_rejected`, `early_return_run_does_not_rotate_versions` pass; probe step 4 (`--version` between compiles, chain intact). Guest complexity limits are ts-side (npm wrapper), unaffected.
5. **enter_program scope refactor** — yes. New upstream `ProgramScope::drop` restores the previous current program (`core.rs:4903-4913`) — exactly the fork's contract (scope drops with the compile frame → no program current at `end_run` → `release_program`'s panic-on-current invariant holds). `set_thread_program` appears nowhere in fork code.
6. **Tests** — yes, 11/11 native ts_wasm tests pass, all six mission-listed tests included (many_runs, early_return rotation, cwd, case-flag, constant-mtime, parse-cache-counter). Plus upstream's new wasm test adapted and green (conflict #9).
7. **ABI frozen** — yes. `ts_input`/`ts_run`/`ts_output`/`ts_output_len` unchanged in the rebased `exports` module; no new JS-visible exports.

## Validation

**Gates (RUSTUP_TOOLCHAIN=1.95.0):**
- `cargo fmt --all -- --check` — green
- `cargo clippy --locked -p ts_goport -p goport_core -p goport_util -p goport_lsproto -p ts_wasm --all-targets -- -D warnings` — green (5 crates; CI's 4 + ts_wasm)
- `cargo test --release --locked -p ts_wasm` — **11 passed, 0 failed**
- CI `wasm` job parity: `cargo test --locked -p ts_wasm --target wasm32-wasip1` via `scripts/wasm/test-runner.mjs` — **1 passed** (after conflict-#9 fix)

**Probe (rebuilt artifact, one held `WebAssembly.Instance`):** all 8 steps correct — clean (emit ✓) / red TS2322 a.ts / edit→clean+emit / `--version` between runs (chain intact) / new-file TS2322 c.ts / fix→clean / fingerprint replay-hit / replay-miss on changed world.

**Structured-failure probe:** 3000-term chain → caught `RangeError: Maximum call stack size exceeded` → mapped 500, not a hang; recycled instance then serves TS2322 correctly (exit 2).

**Memory spot-check (50→100-run new-filename soak, changed config each run):** both artifacts show a ~25 MB one-time page high-water at the first versioned run, then a settled window. Settled window (runs 25–75): **20.5 KiB/run** — matches the ~20 KiB/run eviction bound. Decisive: growth from run 50→100 is **exactly 0 pages** (28,416 KiB at both marks). Pre-rebase artifact control, same harness: same shape, plateau ~0.5–2 MB lower (upstream's larger per-version tables — `source_file_meta_datas`, id-carry, etc. — not a leak; zero-growth plateau proves eviction).

**Artifact:** `npm/wasm/ts_rust.wasm` via `scripts/wasm/build.sh` (wasm profile + wasm-opt + function order), pinned 1.95.0 + binaryen 132:
- sha256 `e05783c80872375e5f5a578d8f535da44abfa6a9de4c1ac904ebefc43b242a71`
- 5,195,794 bytes raw (pre-rebase 5,261,500 — 1.2% smaller, upstream size work), gzip 2,237,066

**Push:** `git push --force-with-lease=multi-run:d7f40d123… fork multi-run` (SSH; HTTPS push was rejected — the credential lacks `workflow` scope and the rebased branch carries upstream's `.github/workflows/ci.yml`). PR #85: OPEN, head `6281c42f4`, `mergeStateStatus: CLEAN`, `mergeable: MERGEABLE`.

## For orchestrator

PR #85 body touch-ups recommended after the flip (current body still describes the db3cadc3-based series):

1. **"Diff: +327/−11, all in `crates/ts_wasm`"** → now **6 files, +1503/−20**: `crates/ts_goport/src/program/multirun.rs` (+816), `crates/ts_wasm/src/lib.rs` (+611), `crates/ts_goport/src/execute/execute_tsc.rs` (41), `crates/ts_wasm/src/host.rs` (35), `crates/ts_goport/src/program.rs` (9), `npm/wasm/core.js` (11). Rebased onto upstream `91f3d021c` (checker-port R250 landed; fork uses the same `register_program_version`/`enter_program`/`release_program` machinery the body cites — claim still accurate).
2. **Memory claim** ("flat — exactly 62,521,344 bytes from run 2 to 50") → re-stated against the rebased build: ~25 MB one-time page high-water at the first versioned run (both pre- and post-rebase builds), then **20.5 KiB/run settled (runs 25–75) and zero growth over runs 50–100**. If the body keeps a byte-exact figure, re-measure with the harness noted above (new filename + changed config per run).
3. **Host contract section** is now stale: the parse cache keys by **content hash** (xxh3-128) + parse options, not mtime — a constant-mtime host (npm `memoryFileSystem`, every mtime 0) is served correctly. The "hosts must stamp a monotonic mtime" requirement should be dropped; the negative control is `constant_mtime_host_still_rechecks_changed_content`.
4. **New upstream API interaction** (worth a Notes line): upstream's `release_checker` (PR #82) reads the current program; between multi-run runs none is current, so an embedder freeing checkers between runs holds `multirun::enter_last_version()` (new `#[doc(hidden)]` hook) — upstream's wasm test was adapted accordingly (commit `6281c42f4`).
5. The body's "one instance, one run" motivation, ABI-freeze claim, recycle guidance, and validation-suite numbers remain valid as written.
