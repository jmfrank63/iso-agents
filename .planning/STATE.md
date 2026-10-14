# State: iso-agents

**Project:** iso-agents — see [PROJECT.md](PROJECT.md)
**Core value:** The full agent loop — generate → type-check in-isolate → execute in-sandbox → feed errors back → fix — demonstrably runs end-to-end inside workerd, observable via HTTP with per-step timings.
**Milestone:** v1 (roadmap defined 2026-10-11 — see [ROADMAP.md](ROADMAP.md))
**Last updated:** 2026-10-11 after Phase 1 execution

## Current Focus

**Milestone v5: complete** — five milestones shipped (v5 = Sol-review hardening + upstream PR #85 + launch runbook)

## Position

- Phase 1 — Worker scaffold + health endpoint: **complete (DELIVERED — live-verified, 8/8 in-workerd tests)**
- Phase 2 — In-isolate type-check core: **complete (DELIVERED — 42/42 live harness; TS2322@1:7 in 191ms cold, 52ms warm in-isolate)**
- Phase 3 — QuickJS-WASM sandbox executor: **complete (DELIVERED — 82/82 live harness; while(true)→structured timeout 532ms; no crash-poisoning; zero host eval)**
- Phase 4 — Agent loop + LLM + observability: **complete (DELIVERED — mock loop success in 3 iters, 330ms total; 135/135 live; milestone v1 tagged v0.1.0)**
- Phase 5 — tsc-rs integration + agent shell runtime (milestone v2): **complete (DELIVERED — 189 live ok/0 FAIL; bench table committed; /agent/shell live)**

## Recent Decisions

Binding on planning (source: [research/SUMMARY.md](research/SUMMARY.md)):

- **TypeScript pin: pure-JS line only, never 7.x** — `npm i typescript` now resolves to native tsgo 7.x, unrunnable in-isolate. Exact pin (`6.0.3` vs `~5.9.3`) decided by the Phase 2 in-workerd spike; boot-time version/API assertion required so accidental upgrades fail loudly.
- **QuickJS: sync variant, fresh single-use contexts** — no asyncify; every execution gets a new context (crashed/stack-overflowed guests poison cached WASM state, uncatchably); dispose in `finally`; `setMaxStackSize` always.
- **Counter-based interrupt for the sandbox deadline** — `Date.now()` freezes during sync guest execution, so wall-clock deadlines don't work; the op-count interrupt handler is the hard backstop. A `while(true)` guest must return a structured timeout, never hang `wrangler dev`.
- **No host eval / `new Function` anywhere** — workerd forbids dynamic eval; QuickJS-WASM is the only execution path; guests get zero host functions except injected `console`/`assert`.
- **Fully hand-rolled CompilerHost** — never `ts.sys` / `ts.createCompilerHost`; lib `.d.ts` inlined as bundled text; lib SourceFiles memoized (128 MB shared JS+WASM isolate).
- **Ordering hard requirement** — sandbox timeout/memory limits must exist before the agent loop's first real (non-fixture) run; hence Phase 3 before Phase 4.
- **In-memory run store only** — no DO/KV/persistence; runs die with the isolate and 404s say so.

## Recent Decisions (Phase 3)
- singlefile QuickJS variant is DEAD on workerd (Wasm code generation disallowed) — wasmfile variant + newVariant({wasmModule}) + committed 491KB .wasm (CompiledWasm default rule)
- stack limit 64KiB (hard cap 128KiB): 1MiB caused uncatchable RangeError + dispose-abort poisoning; ≤128KiB overflows are catchable InternalError
- performance.now() ADVANCES inside the sync guest — wall-clock interrupt handler is primary, op-count backstop secondary
- VmFunctionImplementation has NO leading this handle (FFI applies guest args) — type-level this-param only

## Recent Decisions (Phase 2)
- vitest plugin transport rejects the 8.8MB typescript module (WS 1009) — worker-dispatching tests live in `npm run test:live` (wrangler dev harness), vitest keeps small-module specs only
- Never set the `lib` compiler option with a Map host — getDefaultLibFileName bare-key path is the only servable one (verified)
- wrangler Text rules with fallthrough:true deliver the 57-file lib.es2022 closure (458.9KB) as bundler-native modules

## Recent Decisions (Phase 1)

- workerd freezes `Date.now()` in global scope (reads ~0) — lazy-memoize boot/instance values on first request (fixed in 01-01, commit 861c634)
- `no_nodejs_compat` + `no_nodejs_compat_v2` both set; healthz `workerd`/`userAgent` = `navigator.userAgent` (no in-band version API)
- typescript pinned exactly 6.0.3 in package.json

## Recent Decisions (milestone v3)
- PREMISE CORRECTION: 'tsc-rs has no WASM' was registry-true but source-false — crates/ts_wasm (wasm32-wasip1, 4.2MB, in-memory files mode) exists upstream, UNPUBLISHED; Phase 6 = build-from-source spike + TscRsWasmTypechecker behind TSCHECKER env

## Next Actions (post-v3)

1. Milestone v2 complete. Candidates for v3: SSE streaming, Durable Object state, tsc-rs WASM seam when published, sidecar mode.

## Blockers

None.
