# Phase 10: Luna audit remediation | **Researched:** 2026-10-14

Fork engineer run: branch `multi-run` @ d124fd8 (rebased onto upstream db3cadc3), remediation commit **c6b29c031**. All engineering in /tmp/tsrust-spike/ts-rust; no GitHub pushes/comments (orchestrator handles).

## Verdict

| Fix | Verdict | One line |
|---|---|---|
| FIX A | **done** | Constant-mtime host mode + regression test `constant_mtime_host_still_rechecks_changed_content`; verified it FAILS with content-less cache keying (stale `'one'` parse replayed) and PASSES with the content-hash key. |
| FIX B | **done** | `perform_incremental_compilation` now wraps its host with `multirun::wrap_host` (same as `perform_compilation`), so `--incremental`/composite runs get parse reuse; new end-to-end test `incremental_config_runs_report_each_guest` (red→green→red across one process). |
| FIX C | **done** | `install_program_version` parses + builds the version under one `enter_program(None)` scope (the core.rs:4853-4861 contract), then makes it current with `set_thread_program(Some(version))` + `CURRENT` after the build; RETIRED/CURRENT/INSTALLED_RUN rotation unchanged (all existing tests pass untouched). |
| FIX E | **done** | Per-run scratch map `RUN_HASHES` (path→xxh3) populated by `get_source_file`'s key computation; new `end_of_run_world_fingerprint` hashes the reused values (no second read per cached file); the pre-run check drops leftovers and reads fresh. Replay still hits — probe-asserted. |

**GATES:** fmt (pinned 1.95.0) **green** · clippy `-D warnings` all 5 crates **green** · `cargo test -p ts_wasm` 10/10 **green** (8 existing + 2 new) · repeat-run probe 9/9 steps × 2 runs **green** · production artifact rebuilt via `build.sh` (1.95.0, wasm profile, wasm-opt + function order) **green** · ABI exports/imports unchanged **green** · diagnostics byte-parity unchanged **green** (exact-JSON test asserts still pass; probe diagnostics identical to pre-fix artifact run).

**ARTIFACT:** `npm/wasm/ts_rust.wasm` — 5,261,351 bytes, sha256 `ab4fd30ddb526824ed5a127bf59d9540c1e635802237e6b1dd8f44235727d91b` (gitignored, not committed; built from c6b29c031).

## Per-fix details

### FIX A — constant-mtime regression test
- `crates/ts_wasm/src/host.rs:318-331` — `CONSTANT_MTIME` flag + `test_host::set_constant_mtime(bool)`; `Op::Stat` (host.rs:367-376) reports mtime `1` for every file when set, emulating the npm package's `memoryFileSystem` (mtime 0 for everything — the reviewer's repro host).
- `crates/ts_wasm/src/lib.rs:663` — test `constant_mtime_host_still_rechecks_changed_content`: red guest (`export const n: number = 'one';`) → run 1 TS2322; same-size content change to green (`= 3.141;`) with mtime constant → run 2 clean, emit updated; back to red → run 3 TS2322 again.
- **Revert-check (per mission):** patching `MultiRunHost::cached` to ignore `content_hash` (emulating mtime-keyed behavior — same path key regardless of content) makes the test FAIL exactly as the reviewer predicted: run 2 replays the stale parse and reports TS2322 with the OLD `sourceLines` (`'one'`) against the new green file. Restored; test passes.

### FIX B — wrap the incremental/composite path
- Finding: `perform_incremental_compilation`'s `install_program` call (execute_tsc.rs:688) already routed to `multirun::install_program_version` when the flow is on — but the host passed in was **unwrapped**, so the version's parses never consulted the process parse cache: incremental runs had no reuse and never populated the cache.
- `crates/ts_goport/src/execute/execute_tsc.rs:674-680` — `wrap_host` applied right after `new_cached_fs_compiler_host`, structurally identical to `perform_compilation` (execute_tsc.rs:784). Both call sites studied first: the incremental path's program construction is the same `install_program` → `new_frontend_program` flow (no `build_program` divergence at this site), so a copy — not an adaptation — was correct. The build-info read (`read_build_info_program`), the version install, and `new_incremental_program`'s `create_host` all now run over `MultiRunHost` (its overrides are `get_source_file`/`prefetch_parses` only; fs/stat/chtimes pass through — build-info reads are unaffected, content-keyed cache is correct if consulted).
- Gate: `wrap_host` is a no-op unless `multirun::is_enabled()` — native one-program and watch/LS flows unaffected.
- Test `crates/ts_wasm/src/lib.rs:612` — `incremental_config_runs_report_each_guest`: `{"incremental":true}` config, cold red run (build info written), green run, red-again run over warm build info; every reply is the fresh check's and the emit matches the current text. (Correctness holds with or without the wrap — the test pins that the incremental+multirun combination is sound; the wrap's value is parse reuse.)

### FIX C — version lifecycle per the core.rs contract
- `crates/ts_goport/src/program/multirun.rs:131-137` — `install_program_version` opens `let no_program = core::enter_program(None)` before `new_frontend_program` and holds it through `mark_freeable_parses`, LIVE_PATHS bookkeeping, `prepare_semantic_reuse`, and `new_program_version`; dropped explicitly before `set_thread_program(Some(version))` + `CURRENT.set` (multirun.rs:155-159).
- Rationale: `new_frontend_program` (execute_tsc.rs:610) and `new_program_version` (go_frontend.rs:484) each kept their own `enter_program(None)` scopes, but between them the **previous version was current again** during the bookkeeping. The outer scope (the sanctioned `enter_program` API, per core.rs:4847-4855 `set_thread_program` being "only for thread setup") makes the entire parse/build window program-less. `build_program`'s internal `enter_program(Some(new))` for its tables nests inside and restores to `None`.
- Rotation verified untouched: run 1 installs v1 → end_run retires it; run 2 installs v2, end_run releases v1 (not current on the thread — no `release_program` panic); the `--version` early-return no-rotation test still passes unchanged.

### FIX E — hash once per run
- `crates/ts_goport/src/program/multirun.rs:82` — `RUN_HASHES: RefCell<Option<FxHashMap<Path, u128>>>`; populated in `MultiRunHost::get_source_file` (multirun.rs:257-270) from the same read that computes the cache key (insert on successful read; remove on failed read; bundled files skipped — the fingerprint hashes their path only).
- `multirun.rs:364-368` — new `end_of_run_world_fingerprint`: takes the map, hashes reused values (shape: `true` + u128) instead of re-reading text. `multirun.rs:352-357` — `file_world_fingerprint` (pre-run) **discards** any leftover map (hashes describe a world the host may have changed since) and reads fresh. Both feed a common `world_fingerprint` (multirun.rs:373).
- Value-stability (the load-bearing property): a reused hash and a fresh read of the same text produce the same `xxh3_128` value, so a post-run fingerprint matches the next request's pre-run fingerprint for an unchanged world — the E1 replay still hits. Non-bundled fingerprint entries now hash `ok + xxh3(content)` instead of `ok + text`: fingerprint values change (in-process comparison only, never persisted) — no observable behavior change. Also removed a stale duplicated doc paragraph that still described the old mtime-based fingerprint.
- `crates/ts_wasm/src/lib.rs:226` — post-run call switched to `end_of_run_world_fingerprint`.
- Read count per warm JSON request: was N (run parses) + N (pre-check) + N (post-check) = 3N; now N + N + 0 = 2N (config text still read once per fingerprint; pre-run re-reads are the change detector and are irreducible).

## Validation

- **Toolchain:** pinned 1.95.0 throughout (`cargo +1.95.0` / `RUSTUP_TOOLCHAIN=1.95.0`); wasm32-wasip1 installed; binaryen wasm-opt from `/tmp/tsrust-spike/tools/node_modules/binaryen/bin`.
- **fmt:** `cargo +1.95.0 fmt --all -- --check` clean.
- **clippy:** `cargo +1.95.0 clippy -p {ts_goport, goport_core, goport_lsproto, goport_util, ts_wasm} --all-targets -- -D warnings` — all clean.
- **Tests:** `cargo +1.95.0 test -p ts_wasm` — **10 passed, 0 failed** (8 existing unchanged + `constant_mtime_host_still_rechecks_changed_content` + `incremental_config_runs_report_each_guest`). FIX A additionally verified to fail under emulated pre-fix keying (revert-check above).
- **Repeat-run probe** (`/tmp/opencode/probe.mjs`, one wasm instance, N `ts_run` requests, in-memory FS with constant mtimeNs=42 — the repro-host contract): red TS2322 → same-size edit to green (constant mtime, re-check) → same request bytes over changed content (no stale replay) → new filename joins program with its own diagnostic → `--version` between runs then compile still correct → warm replay-hit assertions (<5ms; proves FIX E's reused-hash == fresh-read fingerprint stability) → emit parity. **9/9 PASS on the rebuilt artifact, run twice.** Baseline: 9/9 also passes on the pre-fix phase-9 artifact (fixes change no observable behavior; R5c/R6 assertions are the new coverage).
- **Artifact:** `scripts/wasm/build.sh` (wasm profile, `--flatten --rereloop -Oz -Oz`, function reorder) → 5,261,351 bytes; sha256 `ab4fd30ddb526824ed5a127bf59d9540c1e635802237e6b1dd8f44235727d91b`. ABI frozen: exports still `ts_input`/`ts_run`/`ts_output`/`ts_output_len` (+`memory`), imports still `ts_host.fs`/`fs_take` + WASI preview1 — no changes to the `exports` module. Diagnostics byte-parity: exact-JSON asserts in existing tests (e.g. `{"fileName":"/p/a.ts","pos":13,"end":14,` prefix, code 2322) pass unchanged; probe diagnostics identical across old and new artifacts.

## For orchestrator

**PR-body wording fix (memory claim).** Replace the sentence claiming fixed-size/fixed bookkeeping memory with exactly:

> Memory grows with the live program — one cached parse per program file plus one cached diagnostic list per checked file — and is recycled per run: `end_run` drops the parse-cache entries of paths that left the program and releases the program version of two runs ago, so a long session's footprint tracks the current project, not the history of runs.

Drop "fixed-size bookkeeping" entirely (unsubstantiated per Luna); do not reintroduce a constant bound claim without a measurement.

**Hashing I/O cost note for perf claims.** Add to the perf section:

> Content-hash keying costs one read per program file per run even on a parse-cache hit — that read computes the cache key and doubles as the change detector, so no mtime contract is required of the host. The pre-run replay check additionally reads every cached path once (the host may have changed between requests); the post-run fingerprint reuses the run's hashes and reads nothing. Net: 2 reads per cached file per warm JSON request (was 3 before the post-run reuse), plus the irreducible parse reads on miss.

**Handoff state:** commit c6b29c031 on `multi-run` (local only; push via `git push https://github.com/jmfrank63/ts-rust.git multi-run`). Probe script kept at /tmp/opencode/probe.mjs (not committed to the fork).
