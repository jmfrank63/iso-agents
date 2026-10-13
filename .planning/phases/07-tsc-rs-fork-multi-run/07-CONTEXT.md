# Phase 7 Context: ts-rust fork — multi-run wasm instances

**Phase:** 07 (milestone v4)
**Captured:** 2026-10-13 (auto mode; user decision: fork pingdotgg/ts-rust and implement,
do not file-and-wait)

## Premise (from code reading, binding for the spike)

- "One program per process" is enforced only by `core::set_prog()` (`core.rs:4827`): a
  `OnceLock<&'static GoProgram>` + assert. The wasm crate (`ts_wasm/src/lib.rs`, 247 lines)
  calls `command_line(...)` with `Entry::Only`, once per instance.
- The port ALREADY contains multi-program machinery — `register_program_version`,
  `enter_program`, `release_program` — used by watch/LSP/tests, with explicit frontend reuse:
  "Program files that an earlier version published keep their `GoFile`. The new state shares
  its copies of unchanged frontend data" (`go_frontend.rs:646-660`). CLI `--watch` is flagged
  off on wasm, but the machinery is compiled in (single `ts_goport` crate).
- Therefore the fork = route `ts_wasm` through the existing version-update flow so one
  instance serves many `ts_run` calls with unchanged files' parses reused. No new
  architecture, no wizer, no ABI change.

## Decisions

### Fork approach
[auto] Q: "Which mechanism?" → Selected: **reuse the multi-program machinery** (preferred):
first request as today; subsequent requests create a new program version via the
register/enter/release flow, reusing unchanged files' `GoFile`s. Fallback (only if the version
flow cannot be driven from CLI-shaped requests within the spike): sequential-reset — make
`set_prog` resettable (release old program, clear CURRENT, re-run `command_line`), accepting
that parse reuse may be partial; document honestly which landed and what it buys.

### Instance lifecycle (worker side, post-fork)
[auto] Q: "How does the worker hold it?" → Selected: **one held instance per isolate** (lazy
singleton — same pattern as the JS checker's memoized libs); **recycle after 50 runs and on
any error/panic** (recycle = fresh `WebAssembly.Instance` from the same compiled module,
2-8ms). Panic hook still exits the instance — that's fine, recycling absorbs it.

### Validation gates (in order, all must pass)
[auto] Q: "What proves it?" → Selected: (1) `cargo build` + `npm/wasm` tests green; (2)
repeat-run probe: one instance, ≥5 `ts_run` calls across differing guests — correct
diagnostics each time, run-2+ warm time recorded vs run-1; (3) their `scripts/wasm/diff.mjs`
byte-identical-vs-native harness (subset acceptable if slow — record which); (4) memory
boundedness: `memory.size()` after 50 runs, recycle validated. Then repo integration:
swap artifact, held-instance `TscRsWasmTypechecker` (rename semantics: instance-per-isolate,
not per-check), bench re-run (fresh vs held reported side by side), provenance docs updated
(fork branch + commit), full gate chain.

### ABI and API
[auto] Q: "Changes to the surface?" → Selected: **ABI frozen** (`ts_input`/`ts_run`/
`ts_output_len` unchanged) — the fork is internal flow only. If a reset export proves
necessary, name it `ts_reset()` and document it as a fork extension.

## Notes for downstream agents

- Spike location: the existing clone at `/tmp/tsrust-spike/ts-rust` (pin 569df52); create
  branch `multi-run` and record its commit. Rebuild loop ~6.5 min — use nohup+poll.
- Known single-run suspects to check: `stdio::init()` per run (idempotent?), per-run
  `install_os_override` (`lib.rs:97`), panic hook re-install, thread_local INPUT/OUTPUT
  buffers (already reused per call — good), `HostFs::new()` per run.
- Memory: 128MB isolate shared with JS; track `memory.size()` delta per run; growth with
  stable files should approach zero after warmup if version reuse works — that's the proof.
- If BOTH mechanisms fail within spike budget, the honest negative result + what was learned
  is an acceptable Phase 7 outcome (v0.4.0 ships docs + probe harness either way).
