# Phase 7 Research: multi-run fork spike

**Phase:** 07 | **Researched:** 2026-10-13 | **Engineer:** gsd-phase-researcher (Rust fork engineer)

## Verdict

**MECHANISM LANDED: version-flow** (the preferred mechanism — `register_program_version`/`new_program_version`/`release_program` driven per `ts_run`; the sequential-reset fallback was never needed). **REUSE PROVEN: yes** — held-instance warm runs 71–123 ms vs 494–539 ms cold (~5–7×), correct diagnostics on every run across differing guests, in Node and inside workerd; memory plateaus at exactly 62,521,344 bytes (zero growth, runs 2→50 in workerd).

## Fork

- Branch `multi-run`, commit **`c1b8218339d0`** (base: pin `569df52`), clone `/tmp/tsrust-spike/ts-rust`. Local commit only; not pushed anywhere.
- 5 files changed, **+327 / −11**:
  - `crates/ts_goport/src/program/multirun.rs` — **new module (203 lines)**. `enable()` (marks the process a watch process so re-parses become freeable file versions), `install_program_version()` (builds the frontend program, marks freeable parses, makes the program version from `CURRENT` as `previous`, sets it as the thread program), `end_run()` (releases the version of two runs ago), `MultiRunHost` (a `CompilerHost` wrapper whose `get_source_file` is the watch-host cache test: stat → mtime → cache hit serves the parse with no read/parse; miss parses and caches; `prefetch_parses` false once the cache is non-empty).
  - `crates/ts_goport/src/program.rs` (+2) — `pub mod multirun`.
  - `crates/ts_goport/src/execute/execute_tsc.rs` (+11) — `install_program` diverts to `multirun::install_program_version` when enabled (instead of one-shot `install_new_program`/`core::set_prog`); `perform_compilation` wraps the run's host with `multirun::wrap_host`.
  - `crates/ts_wasm/src/lib.rs` (+~100/−7) — `multirun::enable()` before, `multirun::end_run()` after each `command_line`; `install_os_override` now guarded by `os_override_installed()` (it panics on the second call); native test `many_runs_in_one_process_report_each_guest` (4 sequential runs in one process: clean → TS2322 with changed file → fixed → unchanged, asserting fresh parse of changed text via a generation-stamped mtime); tests serialized by a mutex (the process host state is shared).
  - `crates/ts_wasm/src/host.rs` (+11/−2) — native `test_host` reports a monotonic generation as `Stat` mtime (the stale-parse test hook). Wasm `HostFs` unchanged.
- **ABI frozen**: `ts_input`/`ts_run`/`ts_output`/`ts_output_len` untouched; no `ts_reset` export needed. The npm `assertModuleShape()` integrity check in iso-agents `shim.ts` remains valid.
- Artifact: `npm/wasm/ts_rust.wasm` — **5,150,781 bytes**, sha256 `9cd244ef87da4b399e9b7c408a68e0342b24569d6d126cda3599d0f19b878d06` (pin artifact was 5,125,434 B: +0.5%; gzip 2,195,384 B). Built via their `scripts/wasm/build.sh` (binaryen 132 from `/tmp/tsrust-spike/tools/node_modules/binaryen`; note: `wasm-opt` must be on `PATH` — the interrupted previous attempt failed exactly there).

## How the version flow works

The "one program per process" rule (`core::set_prog`, `OnceLock` DEFAULT + assert) is bypassed entirely: the fork never calls `set_prog`. Per `ts_run` (all on the loading thread):

1. `multirun::enable()` (first run only) → `ast::set_watch_process()`, which turns on freeable file versions, so a re-parse of a changed file is freed with its last holder instead of staying static (the watcher.rs "9 MiB per edit" lesson).
2. `command_line` → `execute_tsc::install_program` → **`multirun::install_program_version(host, config)`**:
   - `new_frontend_program(host, config)` — parses the config + files inside `core::enter_program(None)` (no current program during parse, as the machinery requires), fresh `CachedFs` compiler host per run;
   - `program::mark_freeable_parses(&np)`;
   - `program::new_program_version(&np, previous)` with `previous = CURRENT` — this is `go_frontend::build_program(np, Entry::Version, cwd, previous)`: it registers the version (`core::register_program_version`, flipping the process to MULTI so `set_prog` can never be called again), publishes the files ("program files that an earlier version published keep their `GoFile`… the new state shares its copies of unchanged frontend data", `GoSharedState::new`, `go_frontend.rs:646-660`), and reuses tables for in-place-replaced files;
   - `core::set_thread_program(Some(version))`; `CURRENT = version`.
3. Run proceeds (check + emit) against the current program, as a one-program run would.
4. **`multirun::end_run()`** (after `command_line` returns): `release_program(RETIRED)` (shuts the old checker pool down, frees its tables; asserts it is not current — it isn't), then `RETIRED ← CURRENT`. Exactly **two versions are ever alive**: the live one and its `previous`. The published file stores, static file versions, and the `PARSE_CACHE` (path + mtime → `Rc<ParsedSourceFile>`) persist — that is the reuse.

**Parse reuse**: `MultiRunHost::get_source_file` = the watch host's test (`execute::watcher::WatchCompilerHost`): stat the file; if the cache holds a parse whose mtime matches, serve it (no read, no parse); else parse via the run's host and cache with the new mtime. A changed file must therefore get a **changed mtime from the host fs** — this is a host contract, proven load-bearing below.

**State matrix across runs** — persists: parse cache, published stores/static file versions, live version + `previous` (GoSharedState), `install_os_override` (installs once ⇒ **the first run's cwd is the cwd of every run**; `-p` still varies per request), `CASE_SENSITIVE` (first request's flag wins), `stdio::init` (idempotent: `OnceLock` + atomic store). Resets per run: the fs-facing compiler host, the `System`, writer, diagnostics buffer (thread-local INPUT/OUTPUT reused per call, already correct), panic hook re-installed per `ts_run` (harmless).

## Validation

All four gates pass, in order. Environments: Node 24.19.0 (aarch64 linux) and `wrangler dev` 4.149.0 / workerd (the real target), probe `/tmp/tsrust-spike/probe2/probe.mjs` + `/tmp/tsrust-spike/probe` (HTTP worker, adapted: held fs so mtimes stay monotonic across requests — a per-request fresh fs would repeat mtime stamps and can serve stale parses).

**(a) Tests** — `node --test npm/wasm/test/tsc.test.mjs`: **14/14 pass** (sandbox quirk: this environment's Node leaks `--v8-pool-size=...` etc. into `process.execArgv`, so worker spawns fail `ERR_WORKER_INVALID_EXEC_ARGV` unless started with `node --import /tmp/tsrust-spike/reset-execargv.mjs` — environmental, not fork-related). `cargo test -p ts_wasm --lib`: **2/2 pass**, including the new multi-run test (4 sequential runs, one process; changed file re-parsed — stale-parse asserted via emitted output; unchanged file's diagnostics correct).

**(b) Repeat-run probe (decisive)** — ONE instance, sequential `ts_run` calls over differing guests (clean fib-iter3 → `const n: number = 'one'` → slugify-iter1 → fib-iter1 → clean again, +3 alternating), exact iso-agents mock guest texts, tsconfig `strict/es2022/lib es2022`, `include: ["*.ts"]`, guest-globals.d.ts, `-p /app --noEmit`, diagnostics JSON. **Correct diagnostics on every run** (0/[ ], 2/[2322], 2/[2322,2322], 2/[2322], 0/[ ]). Wall ms per run:

| run | guest | Node ms | workerd ms |
|---|---|---|---|
| 1 | clean (cold) | 503.6 | 539 |
| 2 | ts2322 | 113.1 | 123 |
| 3 | slugIter1 (2 diags) | 103.8 | 101 |
| 4 | fibIter1 | 85.0 | 90 |
| 5 | clean again | 80.9 | 85 |
| 6–8 alternating | slug/clean | 77.1 / 75.8 / 74.5 | 80→71 by run 50 |

Warm ≈ **70–125 ms vs 494–539 ms cold** (≈4–7×; the guest corpus is tiny — the absolute win scales with lib/config parse volume).

**(c) Memory + recycle** — 50 sequential runs alternating two guests (every run changes `guest.ts` ⇒ every run re-parses it; tsconfig + globals reused):
- Node: 57.6 MB (run 1) → 62.5 MB by ~run 9, then **exactly 62,521,344 bytes flat through run 50** (first-5 avg → last-5 avg delta +1.45 MB, all in warmup). Curve shape: step-up during warmup, hard plateau — reuse works, no leak.
- workerd: **flat 62,521,344 bytes from run 2 through run 50** (total window growth 52 KB = one page). Steady state 62.5 MB vs ~57 MB cold one-shot: the second (previous) program version costs ~5.5 MB — comfortably inside the 128 MB isolate.
- Recycle-on-error: corrupt request = 20,000-deep nested object type. Node: `RangeError: Maximum call stack size exceeded` thrown out of `ts_run` (host JS stack exhausted through the `ts_host` re-entry). workerd: HTTP 500 `{"error":"RangeError: Maximum call stack size exceeded","recycled":true}` — the worker dropped the instance. **Fresh `WebAssembly.Instance` from the same compiled module then serves correctly** (workerd: exit 0/[ ] on clean, 162 ms incl. recycle-instantiation, runCount 57, memory back to 56.95 MB cold level; Node: slugIter1 [2322,2322] correct, 185 ms cold). Honest note: in Node the same (non-recycled) instance happened to still answer correctly after the RangeError, but the protocol recycles on any throw regardless — post-panic Rust state is undefined and workerd trap semantics differ.
- Negative control (why host mtimes are mandatory): held instance over a constant-mtime fs (like iso-agents `memfs.ts` today, `mtimeMs: 0` always): after writing the TS2322 guest, the run still returned **exit 0 / `[]` — the stale clean parse was served**. Without per-write monotonic `mtimeNs`, multi-run silently returns wrong diagnostics.

**(d) diff.mjs vs native** — their `scripts/wasm/diff.mjs` harness, native = `@typescript/native-preview` tsgo (d81db91c981d). Coverage: **16 of 31 cases** (all cases runnable without the `--inputs` cache; `query-*` ×9 and `hono-*` ×6 skipped — inputs absent; recorded subset, not full corpus). Result: 10 cases byte-identical (stdout + stderr + every emitted file): multiprog-emit/linked emit same, jsx, decorators, unique-symbols, init, multiprog-basic/cut stdout+emit same, etc. Diffs found: `version` (version string), `casing` (exit 1 vs 2), `multiprog-basic/cut/emit/linked` (exit codes on some step, stdout+emit same), `multiprog-build-dedup`, `decl-maps`, `decl-maps-link`, `text`, `build-ref` (emit text diffs — declaration maps/tsbuildinfo), `external-diag` (wasm panics "Unknown diagnostic message" — unported external diagnostics). **A/B proof these are pre-existing at the pin, not fork regressions**: rebuilt the artifact from clean `569df52` (worktree, shared cargo cache, 2m58s) and ran the same subset — the main table is **identical, case for case**, to the fork table. Environment note: `/usr/bin/time` absent here; ran a copy of their harness with a 2-line `TS_TIME_BIN` env override (commit `c1b8218` contains only the 5 fork files; the harness copy and a 40-line C `time` shim live in `/tmp/tsrust-spike/tools/`).

## Integration Plan Inputs

**Artifact**: copy `npm/wasm/ts_rust.wasm` (5,150,781 B, sha256 above) over `src/typecheck-wasm/ts_rust.wasm` (5,125,434 B); provenance = branch `multi-run` @ `c1b8218339d0` of pingdotgg/ts-rust @ pin `569df52`. `assertModuleShape()` needs no change (import/export surface identical — verify once at swap time).

**`shim.ts` (core changes — held-instance runner)**:
- Split `runTsc` into `getHeldRuntime()` (lazy singleton: imports built once around a **held** `MemoryFileSystem`; `new WebAssembly.Instance(compiledWasm, imports)`) + per-check `runOnHeld(instance, files)`: encode request → `ts_input` → `ts_run` → `ts_output`/`ts_output_len` (the `prepareRun` plumbing is reusable as-is; keep per-access memory views).
- Sync per check: write changed files into the held fs (each write stamps a **new monotonic `mtimeNs`**), **remove files the check no longer has** (stale guests would join `include: ["*.ts"]`).
- Recycle policy (per 07-CONTEXT decision): recycle after **50 runs**; recycle on **any throw** — `WasiExit` with `code >= 2` (panic hook exits; instance dead) and non-`WasiExit` throws (trap/RangeError class) both drop the instance; the next check instantiates fresh (2–8 ms, measured 162 ms end-to-end incl. cold check).
- cwd caveat: the override installs on the first run, so the first request's cwd is permanent. iso-agents always sends `cwd: "/"` + `-p /app` — safe; assert it.

**`memfs.ts`**: `stat` must return per-write monotonic `mtimeNs: bigint` (a `tick++` on `writeFile`/`remove`, never resetting for the fs's lifetime). **Proven load-bearing** by the negative control above. A held fs keyed to the held instance's lifetime is the clean design (the interrupted attempt's per-request-fs pattern can repeat stamps across requests and go stale).

**`checker.ts` (`TscRsWasmTypechecker`)**: hold one persistent seeded map (tsconfig + `guest-globals.d.ts` — both constant, parse-reused forever); per check overwrite `guest.ts` (or write the new guest set and remove the old); semantics change: "instance-per-isolate", timings report `runMs` of the held run (report fresh-vs-held side by side in the bench per CONTEXT).

**Risks**: (1) any write path bypassing the stamp = silent stale diagnostics (the negative control); (2) two program versions alive ⇒ +~5.5 MB steady (62.5 MB total — fits 128 MB isolate alongside JS); (3) first-cwd freeze; (4) a panic between `install_program_version` and `end_run` leaves bookkeeping mid-flight — never reuse the instance after an error (recycle absorbs it, proven); (5) `tsc -b` + diagnostics-JSON remains rejected upstream (unchanged).

**Probe assets (for the bench/re-run)**: `/tmp/tsrust-spike/probe2/probe.mjs` (repeat/memory/recycle modes), `/tmp/tsrust-spike/probe` (workerd held-instance worker, `POST /check|/reset`, `GET /healthz`), logs in `/tmp/tsrust-spike/logs/` (`test-native.log`, `wrangler-multi.log`, `workerd-driver.log`, `diff.log`, `diff-main.log`, `main-build.log`).

## Sources

- Fork: `/tmp/tsrust-spike/ts-rust` branch `multi-run` @ `c1b8218339d0` (base `569df52`); `git diff 569df52..c1b8218` = the 5 files above.
- Read for the mechanism: `crates/ts_goport/src/core.rs:4802-4861` (CURRENT/DEFAULT/MULTI, `set_prog`, `register_program_version`, `set_thread_program`, `enter_program`), `crates/ts_goport/src/program/go_frontend.rs:255-354, 631-709` (`build_program`, `Entry::Only` vs `Version`, shared-state reuse), `crates/ts_goport/src/program.rs:2860-3009` (`new_program_version`, `mark_freeable_parses`, `release_program*`), `crates/ts_goport/src/execute/execute_tsc.rs:574-622` (`install_program`, `new_frontend_program`), `crates/ts_goport/src/execute/tsc/stdio.rs:73-76, 279-297` (idempotent `init`), `crates/ts_goport/src/ast/file_version.rs:240-289` (`set_watch_process`, `free_file_versions`), `npm/wasm/core.js`, `npm/wasm/test/tsc.test.mjs`, `scripts/wasm/build.sh`, `scripts/wasm/diff.mjs`.
- iso-agents (read-only): `src/typecheck-wasm/{shim,checker,memfs}.ts`, `src/typecheck/vfs.ts` (GUEST_GLOBALS_TEXT), `src/agent/mock.ts` (exact guest texts), `.planning/phases/07-tsc-rs-fork-multi-run/07-CONTEXT.md`.
- Probe outputs: `/tmp/tsrust-spike/logs/*.log` (numbers quoted above), `/tmp/tsrust-spike/probe2/probe.mjs`, `/tmp/tsrust-spike/probe/src/worker.js`, `/tmp/tsrust-spike/tools/{bin-time,time-shim.c}`.
