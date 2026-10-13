# Phase 6 Context: tsc-rs WASM — the real Rust checker inside workerd

**Phase:** 06 (milestone v3)
**Captured:** 2026-10-13 (auto mode — user surfaced pingdotgg/ts-rust#development: `crates/ts_wasm`
IS the WebAssembly build we designed the seam for)

## Premise correction (binding)

Milestones v1-v2 stated "tsc-rs has no WASM build; native binaries only." That was true of the
**npm registry** (nothing published — `ts-rust-wasm` not on npm, "Nothing here publishes" per
npm/wasm/README) but false of the **source tree**: `crates/ts_wasm` builds `ts_goport` (the
Rust port of tsc 7.1.0-dev) to `wasm32-wasip1` — 4.2MB module (1.8MB gzip), libs embedded as
LZMA, JSON diagnostics mode, in-memory `files` mode, fresh module instance per run.

## Decisions

### Path
[auto] Q: "Build it ourselves?" → Selected: **yes — research spike first** (recommended default):
install Rust (wasm32-wasip1) + binaryen in the sandbox, clone pingdotgg/ts-rust (depth 1), run
their `scripts/wasm/build.sh` path (or direct cargo: `cargo build --release -p ts_wasm --target
wasm32-wasip1` + `wasm-opt`), verify `npm/wasm` self-tests pass, then probe instantiation inside
a scratch `wrangler dev` worker supplying host imports (`ts_host.fs`, `fs_take`, WASI shim) in
JS. Build may be slow (fat LTO over ~1.3M lines) or fail — report honestly either way.

### Worker integration (if spike succeeds)
[auto] Q: "How does it slot in?" → Selected: **`TscRsWasmTypechecker implements Typechecker`**
(recommended default) — the seam exists precisely for this. Ship `ts_rust.wasm` via the same
CompiledWasm pattern as `src/sandbox/quickjs.wasm`; port `npm/wasm/core.js`'s import shim to
workerd (no Node APIs; `runTsc`-style sync path on the calling thread; fresh `WebAssembly.Instance`
per check — matches the module's own one-instance-per-run model). Behind env flag
`TSCHECKER=tsc-rs-wasm|ts-js` (default ts-js until proven), healthz identity reflects the choice.
Bench gains a third leg; README honesty table updated (the "no WASM published" footnote becomes
"unpublished; built from source at pin <rev>").

### Known limits to document, not solve
[auto] Q: "Stack depth?" → Selected: **document only** (recommended default): deep recursion in
the checker can exhaust the isolate stack (no JSPI in workerd; Node uses 256MB worker stacks,
browsers use JSPI). Our guests are small — fine in practice; a stack-overflow inside the wasm
checker may be uncatchable (same class as QuickJS aborts). One checker instance per run; no
`--watch/--lsp/--api` in wasm anyway.

## Notes for downstream agents

- The spike decides feasibility. If the build fails or the module cannot instantiate in workerd,
  Phase 6 ends as an honest negative result + docs correction (still valuable).
- Never claim "tsc-rs in workerd" until the scratch worker returns real TS2322 diagnostics from
  the wasm module under `wrangler dev`.
- Repo pin: record the exact commit of the clone in docs (they pin upstream; we pin them).
- Unit/live coverage mirrors Phase 2: same guest fixtures (TS2322 @1:7 or 2:9 per fixture),
  identity flip, bench leg, gate chain stays green.
