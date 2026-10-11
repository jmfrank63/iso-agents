# State: iso-agents

**Project:** iso-agents — see [PROJECT.md](PROJECT.md)
**Core value:** The full agent loop — generate → type-check in-isolate → execute in-sandbox → feed errors back → fix — demonstrably runs end-to-end inside workerd, observable via HTTP with per-step timings.
**Milestone:** v1 (roadmap defined 2026-10-11 — see [ROADMAP.md](ROADMAP.md))
**Last updated:** 2026-10-11 after roadmap creation

## Current Focus

**Phase 1: Worker scaffold + health endpoint** — not started

## Position

- Phase 1 — Worker scaffold + health endpoint: not started
- Phase 2 — In-isolate type-check core: not started
- Phase 3 — QuickJS-WASM sandbox executor: not started
- Phase 4 — Agent loop + LLM + observability: not started

## Recent Decisions

Binding on planning (source: [research/SUMMARY.md](research/SUMMARY.md)):

- **TypeScript pin: pure-JS line only, never 7.x** — `npm i typescript` now resolves to native tsgo 7.x, unrunnable in-isolate. Exact pin (`6.0.3` vs `~5.9.3`) decided by the Phase 2 in-workerd spike; boot-time version/API assertion required so accidental upgrades fail loudly.
- **QuickJS: sync variant, fresh single-use contexts** — no asyncify; every execution gets a new context (crashed/stack-overflowed guests poison cached WASM state, uncatchably); dispose in `finally`; `setMaxStackSize` always.
- **Counter-based interrupt for the sandbox deadline** — `Date.now()` freezes during sync guest execution, so wall-clock deadlines don't work; the op-count interrupt handler is the hard backstop. A `while(true)` guest must return a structured timeout, never hang `wrangler dev`.
- **No host eval / `new Function` anywhere** — workerd forbids dynamic eval; QuickJS-WASM is the only execution path; guests get zero host functions except injected `console`/`assert`.
- **Fully hand-rolled CompilerHost** — never `ts.sys` / `ts.createCompilerHost`; lib `.d.ts` inlined as bundled text; lib SourceFiles memoized (128 MB shared JS+WASM isolate).
- **Ordering hard requirement** — sandbox timeout/memory limits must exist before the agent loop's first real (non-fixture) run; hence Phase 3 before Phase 4.
- **In-memory run store only** — no DO/KV/persistence; runs die with the isolate and 404s say so.

## Recent Decisions
- workerd freezes Date.now() in global scope — lazy-memoize boot/instance values (fixed in 01-01)
- Phase 2 must run with no_nodejs_compat flags active; typescript pinned exactly 6.0.3

## Next Actions

1. Run `/gsd-plan-phase 1`

## Blockers

None.
