# Phase 9 Research: incremental recheck spike | **Phase:** 09 | **Researched:** 2026-10-14

## Verdict

**DECOMPOSITION:** a warm run is **~90% check phase, not construction** — `install_program`
(parse→resolve→publish→tables) is **1.2-3.5 ms** with the parse cache (59 hits / 0 misses),
while `emit_and_report_statistics` is **48-54 ms**, of which `get_semantic_diagnostics` over
all files is **47-50 ms** — dominated by re-checking the 57 embedded lib `.d.ts` files every
version (a `--skipLibCheck` experiment drops a warm run to **3.5-4 ms**, confirming the lib
share). The 09-CONTEXT premise ("the floor is per-version program/checker construction") was
**disproven by the data**: construction was already amortized.

**MECHANISM LANDED:** **per-file semantic-diagnostic reuse across program versions**
(`program::multirun`, fork-local) **+ request replay** (E1, `ts_wasm`). A warm changed-guest
check re-runs the checker only over the files a change can reach and returns cached per-file
diagnostic lists for the rest; an identical request over an unchanged host file system replays
the previous reply outright.

**WARM NOW: ~5-8 ms changed-guest** (module guest or shape-stable script-body edit; was
70-74 ms on the same rig), **0.5-0.7 ms identical rerun**, with diagnostics byte-parity and
flat memory. This beats the ≤20 ms "excellent" bar and reaches the V8 warm range (5-12 ms).

## Step 1 data (the ms table per phase)

Rig: direct wasm driver in Node (held instance, same request shape as
`src/typecheck-wasm/checker.ts`: cwd `/`, `-p /app --noEmit`, `FLAG_DIAGNOSTICS_JSON`,
strict/es2022/lib-es2022 tsconfig, guest + guest-globals.d.ts over a monotonic-mtime memfs),
`WASM_PROFILE=release WASM_OPT=none` builds, temporary `Instant` spans
(commit `039d91e`, kept on the branch, not shipped). `A_run_total` lags one run (the span
drops after `report()`); per-run medians below are from the same table.

Warm runs (GREEN guest, after warmup; ms):

| Phase span | ms | note |
|---|---|---|
| `A_run_total` (whole `ts_run`) | 55-70 | 469 cold |
| `B1_host_setup` | 0.0-0.2 | |
| `C_install_program` (construction) | **1.2-3.5** | parse cache: 59 hits / 0 misses; `C1_new_frontend_program` 1.3-2.0, `C2_new_program_version` 0.1-0.2 (`C2a_publish` 0.0-0.1, `C2b_tables_full` 0.1, `C2c_full_tables_of` 0.0-0.1) |
| `D_check_emit` | **48-54** (87-90%) | cold: 304 |
| — bind (all files) | 0.0-1.6 | bind results are shared across versions |
| — **semantic (all files)** | **47-50** | the floor: 57 embedded lib.d.ts + globals + guest, every version |
| — global diagnostics (×2 sweeps) | 1.4-2.6 | |
| — syntactic / options / declaration | ~0 | |
| `E_marshal` (reply join) | ~0 | per-diagnostic JSON is inside D |

Supporting measurements:
- Cold run: parse 82 ms (59 misses), semantic 254 ms — the warm floor is the same semantic phase.
- `--skipLibCheck` leg (host-args experiment): warm changed-guest **3.5-4 ms** — libs are the check.
- Guest-size invariance of the baseline floor: 1-line vs 1000-line guest both ~55 ms warm
  (BIG_1000 ~150 ms in this build: the guest's own check scales; the lib floor does not).
- Baseline (c0291c7) production artifact, same rig: warm identical 76-100 ms, changed-guest-every-run
  70-74 ms, memory flat 65,339,392 B.

## The fix (branch, commit, diff summary; exact mechanism; which lifetime rules were touched)

Branch **`multi-run-incr`** off `multi-run` @ c0291c7, tip **`79ffdb0`**:
- `039d91e` spike: step-1 instrumentation (timing module, spans, counters — measurement only, removed at tip)
- `13d1ad0` multirun: per-file semantic-diagnostic reuse + wasm request replay
- `79ffdb0` spike: remove the step-1 instrumentation (shipping state)

### Mechanism 1 — per-file semantic-diagnostic reuse (`program/multirun.rs`)

The parse cache already guarantees unchanged files keep the *same parse* (`Rc`). A file whose
parse is unchanged, under the same program contents, has the same semantic diagnostics — so
cache the lists and re-check only what a change can reach:

- Cache: thread-local `path → (parse store id, Rc<Vec<Diagnostic>>)`; generation = the interned
  `CompilerOptions` pointer (O(1), exact — `intern_compiler_options` leaks one copy per distinct
  options) + path-set equality with the cached run. Cache holds no program, no tables, no
  checker → **`release_program`/checker-pool lifetime rules untouched**.
- Per run (`prepare_semantic_reuse`, at `install_program_version` before `new_program_version`):
  1. Options pointer or path set changed → full check (cache rebuilds from the fan-out).
  2. Changed = paths whose parse store differs.
  3. Changed empty → reuse every cached list.
  4. A changed file that reaches the **global scope** (script — `external_module_indicator`
     nil — or carries `module_augmentations`/`ambient_module_names`) keeps the rest reusable
     **only when its top-level contribution hash is unchanged**: every top-level statement's
     kind + source text, except a function declaration with an explicit return type, which
     contributes its signature only (start→body start). A body-only edit of an annotated
     function (the agent's actual edit) cannot contaminate any other file — measured: a
     `const console` script edit DOES produce TS2451 on `guest-globals.d.ts`, so a real
     contribution change falls back to the full check.
  5. Otherwise (changed modules): reuse every unchanged file **outside the changed files'
     transitive resolved-import closure** (reverse edges over `resolved_modules` +
     `type_resolutions_in_file`), excluding files with triple-slash `referenced_files` /
     `type_reference_directives` (those resolve outside `resolved_modules`).
- Routing: `program::get_semantic_diagnostics(Node::NIL)` of a multi-run process fans out only
  the non-reused files through the ordinary checker groups, splices cached lists in file order,
  notes freshly computed per-file results, and applies `filter_and_sort_diagnostics` once at
  the end — the same calls, order and sort as the full fan-out.
- Kill switch: `GOPORT_SEMANTIC_CACHE=0` (read once). Full-check cost when rules don't hold ≈
  baseline (no mechanism overhead: one prepare pass over ≤59 file records, one import-closure BFS).

### Mechanism 2 — E1 request replay (`ts_wasm/src/lib.rs`)

`FINGERPRINT` thread-local stores `(DefaultHash of the raw request bytes, world hash, status,
reply)` after each `FLAG_DIAGNOSTICS_JSON` run and returns the stored pair when an identical
request sees the same world. **World hash** (`multirun::file_world_fingerprint`): every path
the parse cache knows, stat-ed now, hashed with its current mtime — a changed, deleted or newly
written guest (or the tsconfig: its text is a pure function of the file set, so a new guest
always bumps it) changes a stat and forces a full run. This inherits exactly the parse cache's
mtime-honesty host contract; no new host contract. (A bridge write counter was tried first and
rejected: the module cannot see host-side memfs writes through the wasm→host bridge.)

### Measured effect (production artifacts, Node rig)

| Scenario (warm) | baseline c0291c7 | tip 79ffdb0 |
|---|---|---|
| identical request (any guest) | 76-100 ms | **0.5-0.7 ms** |
| changed module guest (GREEN↔BIG, RED↔GREEN after learn) | ~70-74 ms | **~5-8 ms** |
| changed script guest, body-only edit (slugify iter↔final) | ~70-74 ms | **~6-9 ms** (first-ever shape: one ~86 ms full check to learn the contribution baseline) |
| changed script guest, new top-level contribution | ~70-74 ms | one full check (~90 ms), then warm |
| 1000-line guest identical rerun | ~152 ms | **0.6 ms** |

## E1 (fingerprint cache: what it covers, measured identical-rerun ms)

Covers: identical request bytes (cwd + flags + args — the guests ride the fs bridge, not the
request) over an unchanged stat-world of every parse-cache path. Measured identical rerun:
**0.4-0.9 ms** across all guests incl. the 1000-line guest (was 75-100 ms). JSON-flag runs only
(a text run would also have to replay stdout); text-mode requests bypass the cache entirely.
Rotation safety: a replay skips `install_program_version`/`end_run` symmetrically, so
`CURRENT`/`RETIRED` and `INSTALLED_RUN` stay balanced (the existing `--version` regression test
class still passes). Regression tests added in `ts_wasm` pin both stale-reply hazards:
`identical_request_over_a_changed_guest_rereports`, `script_body_change_rereports_and_shape_change_rechecks`.

## Validation (gates, probe tables, memory soak, parity)

- **Pinned toolchain (1.95.0) gates**: `cargo +1.95.0 fmt --all --check` ✓;
  `cargo +1.95.0 clippy --workspace --all-targets -- -D warnings` ✓ (5 build crates +
  2 codegen crates). Both re-run on the clean tip.
- **`cargo test -p ts_wasm`: 6/6** (4 existing — incl. `many_runs_in_one_process_report_each_guest`,
  the stale-parse control — plus 2 new regression tests above).
- **Repeat-run probe** (changed-guest-every-run, 12 runs, production artifact):
  `[7.1, 89.6, 7.6, 6.1, 5.5, 6.4, 6.6, 6.0, 5.9, 6.1, 5.5, 5.8]` ms (89.6 = first GREEN→RED
  contribution learn); script-body leg `[85.8, 9.3, 7.2, 6.9, 6.4, 6.4, 6.5, 6.8, 6.8, 6.3, 6.3, 6.0]`.
  ≥6 runs per scenario as required.
- **Diagnostics byte-parity** (kill-switch A/B, JSON replies compared byte-for-byte):
  - Guest matrix + mixed sequence (identical reruns, module changes, script changes, script
    body edits, 1000-line guest): **66/66 replies identical** — verified on the `-Onone` build
    AND the wasm-opt'd production artifact.
  - Targeted probes: import closure (a.ts→b.ts: change `a`, `b` re-checks and re-reports
    TS2322; fix → clean; signature change → re-report), structure change (remove/re-add a
    file), script contribution change (`const console` → TS2451 on both sides), options change
    (args flip `--skipLibCheck`): **14/14 replies identical**.
- **50-run memory soak** (production artifact, held instance): flat **62,062,592 bytes** at
  every sample (~66 total runs incl. matrix; baseline artifact: flat 65,339,392 — the new build
  is *lower*, fewer checkers spawned per warm run). `-Onone` build: flat 62,259,200.
- **npm/wasm tests**: NOT runnable in this sandbox — this environment's Node injects execArgv
  flags that Workers reject (`ERR_WORKER_INVALID_EXEC_ARGV`); verified environmental: the
  baseline artifact fails identically (3/14 pass both). The wasm ABI surface is covered by
  `cargo test -p ts_wasm` and the direct-driver harness used for every table above.

**Production artifact**: rebuilt via `scripts/wasm/build.sh` (wasm profile + wasm-opt +
function order) from the clean tip `79ffdb0` — `/tmp/tsrust-spike/artifacts/ts_rust.wasm`
(= `/tmp/tsrust-spike/ts-rust/npm/wasm/ts_rust.wasm` on the branch):
**5,166,826 bytes**, gzip 2,201,267, **sha256 `5a2d5914f95babd740e9686ae397d3883d98718abe43ee8fb4ee9750c1ba6e2f`**
(baseline rebuilt for comparison: 5,151,165 B → **+15.7 KB** for the two caches).

## Integration Plan Inputs (artifact path+size+sha256; any NEW host contracts; shim/checker changes needed in iso-agents)

- **Artifact**: `/tmp/tsrust-spike/artifacts/ts_rust.wasm` — 5,166,826 B,
  sha256 `5a2d5914…c1ba6e2f` (full hash above). Drop-in replacement for
  `src/typecheck-wasm/ts_rust.wasm`; **identity bump**: `TS_RUST_FORK_COMMIT` → `79ffdb0`
  (branch `multi-run-incr`), which updates the checker id string automatically.
- **No ABI change**: `ts_input`/`ts_run`/`ts_output`/`ts_output_len` untouched (the temporary
  `ts_debug_timings` export existed only on commit `039d91e` and is removed at the tip).
- **No new host contracts**: the mechanisms rely only on cwd `/` pinning, monotonic mtimes per
  write, and `FLAG_DIAGNOSTICS_JSON` — all existing iso-agents behavior (checker.ts/shim.ts/memfs.ts
  unchanged). One inherited contract is now load-bearing and worth a comment at integration:
  file text changes MUST come with a changed mtime (already true of the memfs stamps — it was
  already load-bearing for the parse cache).
- **Shim/checker changes needed: none.** Held-instance semantics, recycle-on-throw,
  `TSCHECKER_WASM_RECYCLE_AFTER`, mapping and guard are untouched. Bench expectations: the held
  warm medians should drop from ~77-96 ms to single digits; fresh legs are unaffected.
- **Watch-outs for the live harness (phase-9 re-ship)**: (1) first-ever script *shape* costs one
  full check (~90 ms) to learn its contribution baseline — the slugify iter1→iter2 flow hits this
  once per distinct top-level signature; identical reruns are ~0.5 ms; (2) `heldStats` memory
  readings will start lower and stay flat; (3) if a future fixture ever asserts on lib-file or
  globals-file diagnostics produced by a *changed script*, the conservative rules still cover it
  (verified: TS2451 case) — do not weaken the contribution-hash fallback.
- **Optional future lever (NOT in this mechanism)**: passing `--skipLibCheck` in the checker args
  drops warm changed-guest to ~3.5 ms but removes lib/globals diagnostics — a semantics decision
  vs the ts-js checker parity surface, to be made deliberately, not bundled here.
- **Fork upstreaming note**: the seam for a future faster checker (tsc-rs WASM) is unchanged;
  the reuse cache sits in `program::multirun` (fork-local module) and dies with the fork if
  upstream ever ships an equivalent.

## Sources

- Measured on this spike: decomposition spans (branch commit `039d91e`), production-artifact
  harness tables, kill-switch parity probes (66 + 14 replies), soak samples — all commands and
  data reproducible from `/tmp/tsrust-spike/meas/{harness.mjs,parity2.mjs}` against
  `/tmp/tsrust-spike/artifacts/ts_rust.wasm`.
- Fork code read: `crates/ts_goport/src/program/multirun.rs`, `program/go_frontend.rs`
  (`build_program`/`replaced_files`/`reused_tables`), `program.rs` (`new_program_version` /
  `release_program*` / `get_diagnostics_of_any_program` / `get_semantic_diagnostics` /
  `intern_compiler_options`), `execute/execute_tsc.rs` (`install_program`,
  `perform_compilation`), `execute/tsc/emit.rs` (`ProgramLike`), `frontend/parser/source_file.rs`
  (`ParsedSourceFile`: store, `external_module_indicator`, `module_augmentations`,
  `ambient_module_names`, `referenced_files`), `frontend/compiler/file_loader.rs`
  (`ProcessedFiles.resolved_modules` / `type_resolutions_in_file`), `core.rs` (`Diagnostic`,
  `Node::file_index`), `ast/node.rs` (`body`/`type_`/`iter_children`), `ast/file_version.rs`
  (`FileText`), `crates/ts_wasm/src/{lib.rs,host.rs}`.
- Host code read: `src/typecheck-wasm/{checker.ts,shim.ts,memfs.ts,mapping.ts}`,
  `scripts/test-typecheck-wasm-live.mjs` (guest matrix), `scripts/bench-tsc-rs.mjs`.
- Prior planning: `.planning/phases/09-incremental-recheck/09-CONTEXT.md` (binding premise,
  constraints, success bar), `07-tsc-rs-fork-multi-run/07-02-SUMMARY.md` (held-instance
  semantics, recycle protocol, memory numbers).
