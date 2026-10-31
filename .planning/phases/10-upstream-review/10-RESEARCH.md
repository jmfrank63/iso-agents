# Phase 10 Research: upstream review remediation | **Phase:** 10 | **Researched:** 2026-10-28

## Verdict

**BLOCKERS: 1 — yes (fixed). 2 — yes (fixed). 3 — yes (fixed).**

**VALIDATION — the review's bar, reproduced then passed.** The review's invariant is "a held
instance matched a fresh instance on all 46 steps". A 24-step probe (`/tmp/tsrust-spike/meas/probe.mjs`)
drives one held instance and a true fresh instance (new `WebAssembly.Instance`, one request) over
the SAME zero-mtime file state through the review's adversarial patterns: edit, add, delete,
rename, option changes (strict→loose, lib es2022→es2020), `--incremental` around `-p`, `-b`
before and after `-p`, `--version` between runs, a broken tsconfig, a second project switch.

- Baseline (PR head `c0291c7`, rebuilt here): **7 held≠fresh divergences of 24 steps** — the
  review's blocker 1 exactly ("run 2 exited 0 where a fresh instance reported TS2322": held
  `status 0, []` vs fresh `status 2, [2322]` on an mtime-0 host) plus missed add/delete/strict/lib
  changes, and blocker 3 exactly (a case-flag change ran with `status 0`, no error).
- Fixed (commit `81895fe`): **PROBE OK — held == fresh on every compile step, 0 failures.**

**VALIDATION — gates (pinned toolchain 1.95.0):**

| Gate | Result |
|---|---|
| `cargo +1.95.0 fmt --all --check` | ✓ |
| `cargo +1.95.0 clippy --workspace --all-targets -- -D warnings` (native) | ✓ |
| `cargo +1.95.0 clippy -p ts_wasm --lib --target wasm32-wasip1 -- -D warnings` (the scope build.sh ships) | ✓ |
| `cargo +1.95.0 test -p ts_wasm` | **6/6** (4 existing incl. `many_runs_in_one_process_report_each_guest` + 2 new regressions) |
| `npm/wasm` tests (`node test/tsc.test.mjs`) | **14/14 pass** (see Sources for the sandbox workaround) |
| `scripts/wasm/diff.mjs` vs native tsgo | **16/16 runnable cases ok** — exit status, stdout and emitted files byte-equal, `native-st` same (15 query/hono repo cases skipped: inputs cache absent in this sandbox) |
| production artifact rebuild (`scripts/wasm/build.sh`, pinned toolchain) | ✓ + sha256 below |

## Changes

Branch **`multi-run`** (PR #85), one commit on the reviewed head:

- **`81895fe`** multirun: fix the review blockers — content-hash parse cache; eviction; freeable
  first parses; `enter_program(None)` parse; incremental host wrap; case-flag rejection.
  Diff: **4 files, +242/−55** (`program/multirun.rs` +168/−, `execute/execute_tsc.rs` +6,
  `ts_wasm/src/lib.rs` +110/−, `ts_wasm/src/host.rs` +13).

Per blocker:

1. **Content-hash cache keying** (`multirun.rs`): `CachedParse` now holds `hash: Option<u128>`
   (xxh3-128 of the text as `Fs::read_file` serves it — the language server parse cache's hash,
   `project/parsecache.rs`'s scheme) instead of the mtime. `get_source_file` reads the current
   text, hashes it, and serves the cached parse on `hash + external_module_indicator_options`
   match (the CodeRabbit options check kept). **Bundled paths skip the read and the hash**
   (`frontend::bundled::is_bundled` — lib text is embedded in the module, constant per process).
   A deleted file drops its cache entry. The stat/mtime contract is gone: verified by the new
   regression `changed_content_under_an_unchanged_mtime_is_rereported` (fails on the baseline
   flow by construction: a `set_files_with_unchanged_mtime` host write, then TS2322 must
   re-report) and by probe steps 1-9 running under an mtime-0 host.
2. **Parse eviction + first-parse freeing** (`multirun.rs`):
   - `end_run` now evicts: paths not in the loaded version's `source_files()` lose their cache
     entries (Go watcher `watcher.go:538` pattern; safe by construction — a returning path is
     hash-checked and re-parsed). A read that finds the file gone drops the entry immediately.
   - The review's deeper finding ("the first parse of each new path stays in memory — their
     480 KB/run") is the publish machinery: a parse whose path was never published is static,
     and a static publish `Box::leak`s the parse for good (`go_frontend.rs`
     `go_files_of_unpublished_stores`). Fix: **the host notes every path before its parse**
     (`ast::note_published_path` — the same pre-note the language server's source file lease
     does, apimem1 fix C), so the first version of a NEW path is a freeable file version:
     owned nodes (M3c), and at publish its store and `GoFile` move into the version (M3b) and
     free when the holders (cache entry, version chain) let go. `MultiRunHost::prefetch_parses`
     now returns `false` — a prefetch worker parse keeps its nodes in the leaked AST arena,
     which would grow one arena per new path; with no workers every parse is an inline parse of
     a noted path. Measured: case (c) **302 → 20 KiB/run** (below).
   - The residual ~5-21 KiB/run is **not parse data**: it is fixed-size per-run bookkeeping of
     the version machinery itself (leaked per-version `GoProgram` shells — core.rs "the shell
     stays leaked", the append-only `DEAD_FILES` id list at `ast/file_version.rs:228`, registry
     slots). Measured independent of guest size: 30-line guest 15.3 KiB/run vs 294-line guest
     14.9 KiB/run. Bounded by instance recycle (iso-agents recycles at 50 runs → ≤ 1 MiB per
     generation).
3. **CASE_SENSITIVE rejection** (`ts_wasm/src/lib.rs`): the `OnceLock` set is now guarded like
   the cwd guard — a run whose `FLAG_CASE_INSENSITIVE` bit contradicts the locked mode is
   rejected with exit 1 and an explicit message ("one case-sensitivity mode per instance").
   Regression test `case_flag_change_is_rejected` (rejects, then the next run still works).

Small points:

- (a) drop-left-paths — done, part of blocker 2 (eviction above).
- (b) `--incremental`/composite parse reuse — **done**: `perform_incremental_compilation`
  (execute_tsc.rs:680 site) now wraps its host with `multirun::wrap_host`, exactly as
  `perform_compilation` (:776) does. Correctness proven by the probe's `--incremental` steps
  (held == fresh incl. re-report after edit); the reuse itself follows from the wrapped host.
- (c) `set_thread_program` — the semantic half is **done**: the parse now runs inside
  `enter_program(None)` and the scope drops before the version is made current, as the other
  version users do. The API half stays (with an acknowledging code comment): the version must
  remain current after `install_program_version` returns, with no scope to hold, and
  `install_program` returns `()` — `set_thread_program` is the only fit.

Not touched (per mission): E1 fingerprint replay and the incremental diag cache (they live on
`multi-run-incr`, stacked on `c0291c7` — that branch now needs a rebase onto `81895fe`).

## Memory curves after fix

Production artifacts, same rig (held instance, Node driver `soak.mjs`, ~300-line guest, warmup
excluded), pinned 1.95.0 builds. Baseline = PR head `c0291c7` rebuilt here; the review's numbers
(their rig) in parentheses:

| Case | Baseline (this rig) | **After fix** | Review's baseline |
|---|---|---|---|
| (a) identical reruns ×600, mtime-0 host | 59.3 → 62.6 MiB (+5.7 KiB/run) | **61.3 → 64.4 MiB (+5.3 KiB/run)** | 102.6 → 108.3 (~9.5 KiB/run) |
| (b) one edited file ×600, stamping host | 59.3 → 67.8 MiB (+14.5 KiB/run) | **61.3 → 69.9 MiB (+14.8 KiB/run)** | 103.0 → 128.6 (~43 KiB/run) |
| (c) new filename each run ×200, mtime-0 host, previous deleted | 59.8 → 118.7 MiB (+301.8 KiB/run) | **61.8 → 65.7 MiB (+20.2 KiB/run)** | 103.1 → 198.1 (~480 KiB/run) |

Headline: the new-path leak — the review's "about 480 KB per run" — is **~15× smaller** and now
provably parse-free (fixed-size bookkeeping only). Case (b) is unchanged within noise: re-parses
of published paths were already freeable on the baseline (that is why the review saw ~43 KB, not
~480 KB, there); its residual is the same fixed-size bookkeeping. Absolute flatness for hosts
that cannot reuse paths: recycle the instance (iso-agents already does, `TSCHECKER_WASM_RECYCLE_AFTER`).

## Host contract after fix

**Nothing.** No mtime, no stamping, no monotonic clock: a write whose text differs is detected
by content, whatever the host reports (`npm memoryFileSystem()`'s mtime-0 is now a supported
host, not a hazard). Bundled libs are never even read. The two remaining per-instance constants
are rejected explicitly (exit 1) rather than mis-served: cwd change (pre-existing) and
case-sensitivity flag change (new). A crash still ends the instance; recycling absorbs it
(pre-existing).

## PR-text corrections needed

- "all changes are in crates/ts_wasm, plus a core.js update" — wrong: the PR adds
  `crates/ts_goport/src/program/multirun.rs` and touches `crates/ts_goport/src/execute/execute_tsc.rs`;
  there is no core.js change (as the reviewer said). Now also touches `crates/ts_wasm/src/host.rs`
  (test host helper) — still no core.js change.
- The memory claim ("memory is flat") — replace with the measured curves above: identical reruns
  and edited-file reruns are flat within ~5-15 KiB/run of fixed bookkeeping; new-path-per-run
  was ~480 KiB/run at the reviewed head and is ~20 KiB/run after `81895fe`; hosts wanting
  absolute flatness must reuse file paths or recycle the instance.
- The mtime contract in the README/doc comments ("the host file system must report a changed
  mtime for a file whose text changed") — **remove**: the parse cache is content-keyed since
  `81895fe`; hosts need no mtime at all. `npm/wasm` docs (core.js `memoryFileSystem` comment,
  package README) should state the zero-contract host and the per-instance cwd and
  case-sensitivity constants.
- "The npm runTsc API still makes a new instance per call, so npm users do not get this yet" —
  still true; the PR text should say multi-run requires a held instance driven via the raw
  exports (`ts_input`/`ts_run`/`ts_output`), and that a convenience held-instance API in
  `npm/wasm` is future work.

## Integration impact on iso-agents

- **mtime stamping: no longer needed.** The memfs monotonic stamps can stay (harmless), but the
  09-CONTEXT "inherited contract ... file text changes MUST come with a changed mtime" is no
  longer load-bearing on this branch — worth a comment cleanup at the next integration wave.
- **Artifact**: drop-in replacement `src/typecheck-wasm/ts_rust.wasm` — **5,223,526 bytes**,
  gzip 2,215,601, **sha256 `4aeb26a236d77dfb96499804e8613e7962107851a583cb3a0c7d24ece4a7d552`**
  (built by `scripts/wasm/build.sh`, default wasm profile, pinned 1.95.0, from `multi-run` @
  `81895fe`; baseline-prod for comparison: 5,222,113 B → +1.4 KB for the fixes). Release-flavor
  measurement builds also left at `/tmp/tsrust-spike/artifacts/{baseline,fixed}.wasm`.
- **Identity bump**: `TS_RUST_FORK_COMMIT` → `81895fe` (branch `multi-run`), which updates the
  checker id string (`ts-rust@multi-run/<short> (wasm)`) automatically.
- **Shim/checker changes: none.** ABI frozen (`ts_input`/`ts_run`/`ts_output_len`); held-instance
  semantics, recycle-on-throw, `TSCHECKER_WASM_RECYCLE_AFTER`, cwd `/` pinning all unchanged.
  The case-sensitivity guard only fires if a request flips the flag mid-instance — iso-agents
  never does. Recycle-after-50 keeps the ≤ ~1 MiB bookkeeping residual bounded per generation.
- **Rebase note for `multi-run-incr`** (orchestrator): it rides on `c0291c7` and now needs a
  rebase onto `81895fe`. Its E1 world hash stats every parse-cache path and hashes **mtimes** —
  still correct for iso-agents (its memfs stamps monotonically), but under a zero-mtime host E1
  could replay a stale reply for a changed guest; consider content-hashing E1's world hash in
  the same wave. The parse-cache rebase itself is mechanical (the cache struct changed shape).
- Bench expectations unchanged (phase 7/9 protocols apply); the warm path now reads+hashes
  non-lib files instead of stat-ing them — on this branch's ~90 ms warm scale it is noise; on
  the stacked incr branch expect ≤ ~1-2 ms added on large file sets (libs skip).

## Sources

- Fork work: `/tmp/tsrust-spike/ts-rust`, branch `multi-run` @ `81895fe` (on reviewed head
  `c0291c7` = PR #85 HEAD, fetched as `refs/pull/85/head` after the restart wiped `/tmp`;
  baseline artifacts rebuilt from `c0291c7` for every comparison).
- Drivers: `/tmp/tsrust-spike/meas/{probe.mjs,soak.mjs,fresh-broken.mjs}` — held-instance wasm
  drivers with an mtime-0 (or stamping) `ts_host.fs`, per-step held-vs-fresh comparison, memory
  sampling via `memory.buffer.byteLength`.
- Code read: `crates/ts_goport/src/program/multirun.rs`, `program/go_frontend.rs`
  (`go_files_of_unpublished_stores` Box::leak / KeptLists / PUBLISHED_OUTSIDE,
  `mark_freeable_parses`, `new_program_version` + `enter_program(None)`),
  `project/parsecache.rs` (the content-hash scheme), `ast/file_version.rs` (FileVersion
  liveness M3a-M3d, `freeable_path`, `note_published_path`, DEAD_FILES, the apimem1
  lease-pre-note precedent), `ast/store.rs` (`publish_file_stores`), `frontend/compiler/host.rs`
  (`bundled_text`, freeable inline parses), `frontend/compiler/files_parser.rs` (prefetch
  workers, `prefetch_parses` gate), `execute/execute_tsc.rs` (`install_program`,
  `perform_compilation` :776, `perform_incremental_compilation` :680, per-run
  `TscExtendedConfigCache` :432), `frontend/tsoptions/tsconfig_p2.rs` (config text read fresh
  per run), `crates/ts_wasm/src/{lib.rs,host.rs}`, `npm/wasm/core.js` (`memoryFileSystem`
  mtime 0, `runTsc` new-instance-per-call).
- Gates run in this sandbox: npm/wasm tests pass only when the file is run directly
  (`node test/tsc.test.mjs`); the `node --test` runner is broken here (sandbox Node injects
  execArgv flags Workers reject — `ERR_WORKER_INVALID_EXEC_ARGV`, environmental, matches phase 9).
  `clippy --target wasm32` fails on the **pristine baseline** too when feature unification pulls
  goport_core's jemalloc (`--workspace --all-targets` or `-p ts_goport --lib`; goport_core's
  build script itself rejects jemalloc-on-wasm) — the shipped scope (`-p ts_wasm --lib`, what
  build.sh builds) passes. `scripts/wasm/diff.mjs` needed `/usr/bin/time` (absent, no sudo): a
  shim provided RSS via /proc polling (RSS is informational; the pass criteria are status/stdout/
  emit bytes) and `diff.mjs` was patched for it in the working tree only and restored — not
  committed.
