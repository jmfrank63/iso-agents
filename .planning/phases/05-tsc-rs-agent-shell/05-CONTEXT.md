# Phase 5 Context: tsc-rs integration + agent shell runtime

**Phase:** 05 (milestone v2)
**Captured:** 2026-10-13 (auto mode — recommended defaults; direct user driver: the video's
stack — Rust TypeScript + agent-shell — mapped onto workerd isolates "that T3 can directly run
agents on")

## Decisions

### tsc-rs usage — host-side bench, not in-isolate
[auto] Q: "Where does the Rust compiler run?" → Selected: **host-side, via the `tsc-rs` npm
package's native binary, invoked from a bench harness script** (recommended default — the only
honest option: native binaries cannot execute inside workerd; no WASM build exists). The bench
runs tsc-rs and the in-isolate checker on the SAME guest snippets and prints the comparison
table; results go into README. The `Typechecker` interface stays the drop-in seam for a future
tsc-rs WASM build. In-worker behavior does not change.

### Bench design
[auto] Q: "What exactly is measured?" → Selected: **≥5 snippets (the mock scenarios' iterations
+ lib-heavy + error cases), each checked by (a) tsc-rs native CLI/JS-API on a temp file host-side
and (b) POST /typecheck in-isolate (5-run median), cold and warm** (recommended default). Script:
`npm run bench:tsc-rs`, output a markdown table + commit the numbers into README. If the tsc-rs
JS API (`tsc-rs/unstable/sync`) loads on this machine, prefer it over CLI spawning; fall back to
CLI. If the native binary cannot run in this environment at all, report that honestly and keep
the bench script + docs with the measured in-isolate numbers only.

### Agent shell — tool protocol, not a shell process
[auto] Q: "What is 'bash' on an isolate?" → Selected: **`POST /agent/shell` implementing a
tool-protocol session: `{commands: [{op, args}...]}` → `[{op, ok, result, ms}]` executed
sequentially against a per-request VFS** (recommended default). Ops: `ls` (VFS listing), `cat`
(file text), `write` (upsert), `rm`, `run` (transpile + QuickJS execute, inherits sandbox
guardrails + returns ExecuteResult), `typecheck` (checker diagnostics, inherits gate semantics).
No host eval, no processes — the operational surface agent harnesses need, expressed as
stateless HTTP. Halt-on-first-failed-op flag (`{stopOnError: true}` default false).

### Loop integration (minimal)
[auto] Q: "Does the agent loop use the shell?" → Selected: **no change to the loop** (recommended
default) — Phase 4's loop already composes the same primitives; the shell endpoint is the
EXTERNAL harness surface. `/agent/shell` is additive and stateless per request.

### Bookkeeping
[auto] Q: "Guest files in shell vs agent runs?" → Selected: **shell sessions use their own
transient VFS seeded with nothing (plus optional `files` in the request)**; agent runs keep
their own in-loop VFS. No shared mutable state between requests (recommended default).

## Notes for downstream agents

- tsc-rs facts already verified: npm `tsc-rs@0.2.0` (maintainer t3dotgg), optionalDeps
  @tsc-rs/{linux-x64,linux-arm64,darwin-arm64}, exports `./unstable/sync`, `./unstable/async`,
  `./unstable/proto`, bin `tsc-rs`. This machine: linux-x64, node 24 — the native binary should
  run; research must verify the exact invocation (JS API vs CLI) empirically.
- The shell endpoint must pass the no-host-eval gate and inherit Phase 2/3 guardrails; VFS op
  results are JSON-serializable only.
- Live harness: new `scripts/test-shell-live.mjs` (pattern: PID-file boot, free port, teardown);
  bench is host-side only (no wrangler boot needed).
- README restructure: "Why this exists" (the video story) + "Benchmark" table + "Running agents
  on this isolate" (the HTTP contract an agent harness drives: /agent/run, /agent/shell,
  /typecheck, /sandbox/execute, /healthz).
