# Phase 10: enter_program scope refactor | **Researched:** 2026-10-14

Resolves the last open review item (upstream Opus review + GPT-6-Luna audit both flagged it): `install_program_version` made the version current via `core::set_thread_program` + a persistent fork-local `CURRENT`, while core documents `set_thread_program` as thread-setup-only and `enter_program` → `ProgramScope` as the sanctioned multi-program pattern.

**Branch:** `multi-run` @ `5ada636ae` (parent `c6b29c0`; no push — orchestrator handles GitHub).

## Verdict

| Question | Answer |
|---|---|
| `set_thread_program` eliminated from fork? | **YES.** Fork's multirun flow now has zero uses (was multirun.rs:159). Remaining repo uses are upstream files the fork never touched (verified: empty `origin/main..multi-run` diff for `incremental/checker_access.rs`, `program/ls_program.rs`, `program/go_frontend.rs`, `modulespecifiers/host.rs`, `program.rs` seed paths). |
| Parse reuse survives? | **YES — asserted directly on the cache's own counters.** New test `parse_cache_reuses_parses_across_runs` (ts_wasm): run 1 cold `parses>0, hits==0`; run 2 warm `parses==0, hits>0`; run 3 (past the `end_run` rotation that released version 1) `parses==0, hits>0`; run 4 edit `parses>=1, hits>0` (only the changed file re-parses) + correct TS2322 diagnostics. |
| Gates | **GREEN.** rustfmt 1.95.0 `--check` clean; clippy 1.95.0 `-D warnings` clean on all 5 crates (ts_goport, goport_core, goport_util, goport_lsproto, ts_wasm) `--all-targets`; `cargo test -p ts_wasm` 11/11 (10 existing + 1 new); probe 8/8 on one held instance. |
| Artifact | sha256 `1800ad450f8b90302aa0f8bfe45bbcf8eda664796af2847bfc5551d1a1506af9` — `scripts/wasm/build.sh` default profile, 5,261,500 bytes (pre-refactor: 5,261,351, +149 bytes = the new thread-locals/hook), gzip 2,230,795. ABI frozen: exports still exactly `memory, ts_input, ts_output, ts_output_len, ts_run`; request format and `FLAG_*` bits unchanged. |

## Refactor

Three Rust files + one additive JS export, commit `5ada636ae`:

**`crates/ts_goport/src/program/multirun.rs`**
- `install_program_version` → `install_and_enter(host, config) -> core::ProgramScope`. Load body unchanged (parse+build under `enter_program(None)`, `mark_freeable_parses`, LIVE_PATHS, semantic-reuse prep, `new_program_version`); then `LAST_VERSION.set(Some(version))`, `INSTALLED_RUN=true`, and returns `core::enter_program(Some(version))` — the scope makes the version current; **no `set_thread_program`, no persistent `CURRENT`**.
- New thread-local `LAST_VERSION` replaces fork-local `CURRENT`: the authoritative `previous` for `new_program_version(&np, previous)` — **set at install, read at install**. It is explicitly documented as *not* the thread's current program; between runs (and while a version loads) no program is current.
- `end_run`: rotation now `RETIRED = LAST_VERSION.take()`-style (release RETIRED → `RETIRED.set(LAST_VERSION.get())`). `INSTALLED_RUN` early-return guard kept (program-less runs like `--version` rotate nothing). Each version is still released exactly once per run, one run after it stopped being the `previous`.
- Scope lifetime vs `end_run` (documented in `install_and_enter`, `end_run`, and both call sites): the caller holds the scope across the compile; it drops when `perform_compilation`/`perform_incremental_compilation` returns — i.e. before `command_line` returns to `ts_run`, which calls `end_run` after. Order is therefore scope-drop **then** `end_run`, which is required: `release_program` **panics on a current program**, so `end_run` can only release RETIRED once no scope names anything. Verified there is no `prog()` reader between the compile-frame drop and `end_run` (only file reads for the E1 fingerprint).
- New `#[doc(hidden)] pub fn take_parse_cache_counts() -> ParseCounts {hits, parses}` (thread-local, read-and-reset): incremented at the cache-hit early return and after a real parse in `MultiRunHost::get_source_file`. Failed reads (resolution probes) count in neither field. E1 fingerprint and semantic-diag cache logic otherwise untouched (diff-verified).

**`crates/ts_goport/src/execute/execute_tsc.rs`** (call site, ex-:583)
- `install_program(...) -> Option<core::ProgramScope>` with `#[must_use]`: `Some(install_and_enter(...))` in the multi-run flow; the one-program path keeps `install_new_program` (`set_prog`, permanent) and returns `None`.
- Both callers (`perform_compilation`, `perform_incremental_compilation`) bind `let _install_scope = install_program(...)` as an explicit variable in the function scope, holding it across the whole compile/emit; it drops at the frame's end, all early-return paths included.

**`crates/ts_wasm/src/lib.rs`**
- `run()` comment updated (no program current between runs; scope drops with the compile frame, before `end_run`).
- New test (see Correctness).

**`npm/wasm/core.js`** (additive, no wasm-ABI change)
- `prepareRun` is now exported (doc comment shows the held-instance recipe: instantiate once with `run.imports`, call each request's `run.start(instance)` → `ts_run`). Needed by the probe; pure `export` keyword + docs.

## Correctness

**Parse-reuse test (direct cache-behavior evidence, not timing):** `parse_cache_reuses_parses_across_runs` asserts on `take_parse_cache_counts` — run 1: `parses>0 && hits==0`; run 2 (unchanged, alternate request bytes): `parses==0 && hits>0`; run 3 (third run, past the rotation that released version 1): `parses==0 && hits>0`; run 4 (a.ts edited, same length): `parses>=1 && hits>0` and the reply is the fresh check's TS2322 on `/p/a.ts`. Request bytes alternate (`-p .` / `-p /p`) so the E1 fingerprint replay can never serve a reply (it compares only against the *last* run's request hash) — every run really loads a version over the cache. Note: in the pre-existing `many_runs…` test, run 4 actually replays via E1 (identical bytes) — its assertions still hold, but it no longer exercises the parse cache directly; the new test closes that gap.

**Rotation tests:** all pre-existing multi-run tests pass unchanged — `many_runs_in_one_process_report_each_guest`, `early_return_run_does_not_rotate_versions` (INSTALLED_RUN guard with the LAST_VERSION/RETIRED bookkeeping), `cwd_change_is_rejected`, `case_flag_change_is_rejected`, `a_path_that_returns_with_other_content_rereports` (eviction), `identical_request_over_a_changed_guest_rereports` (E1 + semantic cache), `incremental_config_runs_report_each_guest` (wrapped incremental host), `constant_mtime_host_still_rechecks_changed_content`, `script_body_change_rereports_and_shape_change_rechecks`, `run_checks_and_emits_through_the_host`.

**Probe (held instance, one `WebAssembly.Instance`, `npm/wasm/core.js` `prepareRun`; script at `/tmp/tsrust-spike/probe.mjs`):** 1 clean → exit 0, `[]`, emit correct; 2 red → exit 2, TS2322 on `/p/a.ts`; 3 edit → exit 0, `[]`, new emit; 4 `--version` between runs → exit 0, `Version 7.1.0-dev`, no rotation; 5 new-file c.ts (with error) → exit 2, TS2322 on `/p/c.ts` (a.ts/b.ts parses survived rotation + early return); 6 fix → exit 0; 7 identical request + unchanged world → fingerprint replay, same reply; 8 changed world under identical request → replay misses, fresh check reports. **8/8 OK.**

## For orchestrator: PR-body wording touch-ups

- Anywhere the PR body says `install_program_version` "makes the version the current program of the thread", replace with: "loads the version and returns the `ProgramScope` (`core::enter_program`) that makes it current; the caller holds it across the compile".
- The claim "the loading thread keeps the version current for the rest of the run" is now false between runs: current is `None` from compile-frame drop until the next install. Parse reuse is driven by `LAST_VERSION` + the parse cache, not by a current program.
- `end_run` wording "moves `CURRENT` to `RETIRED`" → "retires `LAST_VERSION` into `RETIRED`".
- Optional add: mention the new parse-counter test as the direct reuse evidence (reviewers asked for exactly this).
