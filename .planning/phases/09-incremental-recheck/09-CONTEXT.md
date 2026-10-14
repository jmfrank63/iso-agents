# Phase 8 Context: incremental recheck — amortizing the construction floor

**Phase:** 09 (milestone v6)
**Captured:** 2026-10-14 (auto mode; user goal: "full performance potential — ideally near V8
warm performance", i.e. well under the current ~80-100ms warm floor)

## Premise (measured, binding)

Warm check on the `multi-run` fork is **flat ~80-100ms regardless of guest size** (1 line ==
1000 lines within noise; red-with-diagnostics 77ms; identical re-run ~90ms after settling).
The fork already amortizes decompress+parse (parse cache). Therefore the floor is **per-version
program/checker construction**: every `ts_run` builds a new program version (file/type tables,
checker pool, global-scope merge) even when only one 1-line guest file changed. The
guest-dependent work itself is ~5-20ms.

## Decisions

### Approach
[auto] Q: "How do we attack construction?" → Selected: **instrument, then drive the deepest
reuse that exists** (recommended default, ordered by depth):
1. **Instrument** a local build (Instant timers around: version creation, parse-cache hits,
   bind/table build, check, reply marshal) to decompose the ~80-100ms — data first, no guessing.
2. **Prototype the fix** that the data points to, in order of preference:
   a. watch-style **in-place incremental update** (`ReuseProgram` semantics — the go_frontend
      comment says in-place replacement starts the new tables from the previous ones): if the
      only changed file is the guest, construction should touch only that file;
   b. **persistent checkers** across versions when the file set is unchanged in structure
      (single guest file swapped): release nothing, re-check only the changed file;
   c. if neither is reachable without upstream redesign, report exactly which lifetime rule
      blocks it (`release_program`/checker-pool invariants) — an honest negative with the
      profiling data is acceptable.
3. **E1 rides along** (cheap, ts_wasm-only): request-fingerprint cache — identical request
   returns the previous reply without any version work (~1ms warm re-runs).

### Constraints (unchanged)
[auto] → ABI frozen (`ts_input`/`ts_run`/`ts_output`); diagnostics byte-parity with previous
versions on all fixtures; memory must stay flat across ≥50 runs; no upstream API changes
required for the prototype (fork-local only); branch off `multi-run` @ c0291c7, record commit.

### Validation
[auto] → (1) pinned-toolchain gates (fmt/clippy/-D warnings, `cargo test -p ts_wasm` 4/4);
(2) their npm/wasm tests + diff-subset if runnable; (3) repeat-run probe with the phase-7
guest matrix incl. changed-guest-every-run; (4) 50-run memory soak; (5) re-ship to
iso-agents: identity bump, wasm live harness, bench fresh/held updated, full gates.

### Success bar
[auto] → warm changed-guest check **≤40ms** = success (near-V8: 5-12ms is V8's number; wasm
single-thread parity is not expected). ≤20ms = excellent. No improvement despite profiling =
negative result, documented with the decomposition.

## Notes for downstream agents

- The instrumentation build must not ship — production artifact stays from the clean branch.
- `enter_program`/`release_program`/checker-pool invariants are the likely blockers for (b);
  read `core.rs` program-lifetime comments before fighting them.
- iso-agents worker currently pins cwd "/" and stamps mtimes per write — the fork may rely on
  both (regression-test them if the incremental path adds new host contracts).
