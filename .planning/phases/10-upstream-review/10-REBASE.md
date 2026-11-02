# Phase 10: rebase onto upstream main | **Researched:** 2026-10-14

## Verdict (REBASED: yes | COMMITS: 6 | GATES: green | PUSHED: yes)

`multi-run` rebased onto `db3cadc3` (mission-pinned `origin/main`): 6 commits, zero textual
conflicts, all pinned-toolchain gates green, held-instance probe ALL CORRECT on the rebuilt
artifact, pushed with pinned lease to both `multi-run` and `multi-run-incr` at `d124fd86f`.

**Caveat discovered during push:** `upstream` (pingdotgg) main has moved past the mission
reference: now `91f3d021c`, **949 commits / ~291k insertions beyond `db3cadc3`** (~50
commits/day). PR #85 therefore still shows CONFLICTING/DIRTY on GitHub — the branch is a
clean descendant of `db3cadc3` (`git merge-base` == `db3cadc3` exactly, `git merge-tree`
has 0 conflict markers); the CONFLICTING flag is against the NEW main, not the pinned one.
A second rebase onto `91f3d021c` is a separate large phase (touches program.rs +1702,
store.rs +656, files_parser.rs +997, go_frontend.rs +791, ts_wasm +82) and a moving target;
documented here as follow-up, not attempted, per "an honest partial beats a broken
force-push".

**Remote naming correction for future runs:** in this clone `origin` =
`git@github.com:jmfrank63/ts-rust` (the fork; its `main` mirrors upstream @ `db3cadc3`) and
`upstream` = `https://github.com/pingdotgg/ts-rust`. The mission note had them swapped.
The rebase used `origin/main` which matched the pinned `db3cadc3` exactly, so the result is
as specified. Pushes went via HTTPS URL (SSH agent dead, as warned).

## Conflict log (per commit: files, how resolved)

Git produced **no conflicts in any of the 6 commits** — `git rebase --onto origin/main
569df525d multi-run` auto-merged cleanly and compiled first try. Why: our diffs live almost
entirely in files upstream's 128-commit range (R219 era) did not touch, and the one overlap
(`program.rs`, ours +9 vs theirs 686 changed lines) does not overlap textually.

| # old → new | files touched | resolution |
|---|---|---|
| `c1b82183` → `6d29759b` multirun impl | `program.rs` (+mod decl, nil-source hook), `program/multirun.rs` (new, 684), `execute_tsc.rs` (+2 hook sites), `ts_wasm/{lib,host}.rs` | auto-merge; semantically re-verified anchors below |
| `35e451ec` → `85a995f8` cargo fmt | formatting only | auto-merge |
| `359ee7a` → `8b14b05d` pinned-toolchain gates | formatting/lints | auto-merge |
| `c0291c7b` → `376c5c89` CodeRabbit fixes | `ts_wasm/lib.rs` (opt-hash, cwd/case rejection + tests) | auto-merge |
| `d540d0ba` → `ea53052a` review remediation | `multirun.rs` (content-hash cache, eviction, freeable first parses), `ts_wasm/lib.rs` | auto-merge |
| `6cf7c19a` → `d124fd86f` phase 9 | `multirun.rs` (semantic-diag reuse), `ts_wasm/lib.rs` (fingerprint replay) | auto-merge |

Post-rebase anchor verification (upstream code read before trusting the auto-merge):
- `program.rs:4787-4792` — nil-source `get_semantic_diagnostics` hook intact; upstream's
  diff in this range contains no changes to `get_semantic_diagnostics` /
  `collect_checker_diagnostics_with` / `release_program` lines.
- `execute_tsc.rs:579-583` — `install_program_version` still the wrap point for program
  installation; `execute_tsc.rs:776` — `wrap_host` still inside `perform_compilation`
  (both per the review's recommendation).
- `multirun.rs` API surface survives unchanged upstream: `bundled_text`,
  `note_published_path`, `is_published`, `freeable_path`, `FileVersion::new`,
  `new_program_version`, `release_program`, `mark_freeable_parses`,
  `intern_compiler_options`, `set_thread_program`, `new_frontend_program`,
  `SourceFileParseOptions::external_module_indicator_options`, `prefetch_parses`,
  `freeable_worker_parses` — all compile with identical signatures (the clean
  `cargo check` is the proof).
- `MultiRunHost` delegates `get_source_file` to the inner host, so upstream's new
  worker-parse / stat-cache paths inside `CompilerHostImpl` still execute for misses.

## Validation (gates, probe sequence results, artifact sha)

Gates (pinned 1.95.0):
- `cargo +1.95.0 fmt --all -- --check` — **green** (exit 0)
- `cargo +1.95.0 clippy --locked -p ts_goport -p goport_core -p goport_util -p goport_lsproto -p ts_wasm --all-targets -- -D warnings` — **green** (1m09s)
- `cargo +1.95.0 test -p ts_wasm` — **8/8 pass** (46s), including `case_flag_change_is_rejected`, `cwd_change_is_rejected`, `a_path_that_returns_with_other_content_rereports`, `early_return_run_does_not_rotate_versions`, `identical_request_over_a_changed_guest_rereports`, `many_runs_in_one_process_report_each_guest`, `script_body_change_rereports_and_shape_change_rechecks` — the multirun regressions hold under the rebased internals.

Artifact (`PATH=…binaryen/bin RUSTUP_TOOLCHAIN=1.95.0 CI=1 bash scripts/wasm/build.sh`):
- `npm/wasm/ts_rust.wasm`: **5,259,704 bytes**, sha256
  `494665cc062a091d8db4a294cb8bcecf52d6c6501d4fbe99fe5db04e46c4dbd7`
- gzip 2,229,623 bytes; raw `target/…/ts_wasm.wasm` 7,988,579 bytes

Functional probe (held instance — ONE `WebAssembly.Instance`, repeated
`ts_input`/`ts_run`/`ts_output`; memory FS via `memoryFileSystem`; big-stack worker as
node.js does; diag JSON flag on; probe script `/tmp/opencode/held-probe.mjs`):

| step | request | result |
|---|---|---|
| 1 clean guest | `-p .`, files:[a.ts] | exit 0, no diags (cold 1420ms) |
| 1b replay | identical request, unchanged world | exit 0, **0 ms** — fingerprint replay hit |
| 2 red guest | same request bytes, a.ts edited | exit 2, **TS2322** at /p/a.ts — world hash caught the change, recomputed (828ms) |
| 3 edit same guest | back to clean | exit 0, no diags (563ms) |
| 4 `--version` between runs | cwd /p | exit 0, stdout `Version 7.1.0-dev`, 1ms — early return, no rotation |
| 5 new filename | b.ts enters via config `files` | exit 0, both files checked (555ms) |
| 6 red new file | c.ts enters with type error | exit 2, TS2322 at **/p/c.ts only** (555ms) |
| 7 shrink | back to files:[a.ts] | exit 0 — eviction path exercised (530ms) |

`PROBE: ALL CORRECT`. This exercises multirun program versions, the content-hash parse
cache, per-file semantic-diag reuse, fingerprint replay, early-return no-rotation, and
LIVE_PATHS eviction — all still correct under the rebased (R219-era) program internals.
Probe-setup notes (for reproducers): the instance rejects a cwd change (one cwd per
instance — the guard working as designed) and rejects explicit command-line files when a
tsconfig is present (TS5112), so "new filename" goes through the config's `files` list.

Pushes (HTTPS, lease pinned to the exact stale remote SHA):
- `multi-run`: `6cf7c19aa` → `d124fd86f` (forced update) — PR #85 head updated
- `multi-run-incr`: `6cf7c19aa` → `d124fd86f` (forced update, synced)

## Upstream deltas that touched us (R219 items worth knowing)

Range `569df525d..db3cadc3` (128 commits, the "old-base → mission-pinned" span):
1. **`program.rs` checker pool refactored** to an `InlineChecker` enum
   (`Unmade`/`Busy`/`Made`/`Released`); wasm symbol-id copy now materializes the first
   checker if no job made it; added `Program::single_threaded()` and `#[cfg(test)]`
   bind-thread hooks. No collision with multirun: `new_program_version` /
   `release_program` signatures and version-chain semantics intact, and `end_run`'s
   pool-stop path compiles against the new pool.
2. **`files_parser.rs` (+966)** — parse-worker machinery with a stat cache
   (`LoaderStatFs`), wired into `new_cached_fs_compiler_host` for the plain OS fs.
   Native-side; our `MultiRunHost` sits above and delegates misses, so the stat cache
   still serves its purpose; wasm (our path) is unaffected.
3. **`frontend/compiler/host.rs`** — wasm-only `unpacked_lib_text`: bundled lib files
   whose fs text matches the embedded text get a process-lifetime `FileText`. Consistent
   with (and reinforces) our parse cache treating bundled libs as immutable
   (`bundled=true`, hash 0).
4. **`ast/store.rs` wasm file-id layout** — `LOW_BLOCKS` 65,536 → 8,192 entries (512 KiB
   linear memory instead of 4 MiB `.data`), `HIGH_CHUNK` 8,192; ids beyond take a slower
   chunk path with identical results. Directly complements multi-run held instances:
   file ids accumulate across runs and previously overflowed the wasm low-block range.
5. **`go_frontend.rs` symlink cache seeding** (`SymlinkSeed`) for parallel loads —
   orthogonal to multirun.
6. **`execute/incremental/{affected_files,emit_files}.rs`** — incremental path work; not
   on the multirun check path.

**New upstream movement (post-mission, discovered at push time):** `upstream/main` is now
`91f3d021c` — 949 commits (~291k insertions, 470 files) beyond `db3cadc3`, again touching
every file we hook (`program.rs` +1702, `store.rs` +656, `files_parser.rs` +997,
`go_frontend.rs` +791, `ts_wasm/{lib,host}.rs` +82, `execute_tsc.rs` 19). Follow-up
required: a second rebase of `multi-run` onto the new main before PR #85 can merge; treat
as its own phase with fresh conflict analysis (our textual surface stays tiny — the work
is re-anchoring multirun.rs against the new program/store/parser APIs).
