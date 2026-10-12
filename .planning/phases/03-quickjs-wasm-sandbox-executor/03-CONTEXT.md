# Phase 3 Context: QuickJS-WASM sandbox executor

**Phase:** 03 — QuickJS-WASM sandbox executor
**Captured:** 2026-10-11 (auto mode — all decisions are recommended defaults, logged for audit)

## Decisions

### Variant choice
[auto] Q: "Which QuickJS build?" → Selected: **quickjs-emscripten-core@0.32 + @jitl/quickjs-singlefile-browser-release-sync** (recommended default). WASM is base64-embedded in one ESM file (no runtime `.wasm` resolution under wrangler bundling), the variant family ships first-party `workerd` export conditions, and **sync** is correct because guests are pure-CPU spec code — asyncify costs ~2x size/~40% speed for nothing we need. FALLBACK documented: wasmfile variants also declare `workerd` conditions if singlefile misbehaves under wrangler.

### Context lifecycle
[auto] Q: "Context lifecycle?" → Selected: **fresh single-use context per execution; `dispose()` in `finally`; WASM module loaded once (lazy singleton)** (recommended default). Rationale is binding research: guest crashes/stack overflows are uncatchable WASM aborts that poison cached runtime state (`list_empty(&rt->gc_obj_list)` class of failures) — a fresh context per run makes any poisoning impossible to observe twice.

### Deadline mechanism
[auto] Q: "How does the sandbox deadline work given workerd's frozen clock?" → Selected: **counter-based `runtime.setInterruptHandler()`** (recommended default). `Date.now()` freezes during synchronous guest execution, so wall-clock checks inside the handler cannot fire; instead the handler counts handler invocations (op budget derived from `SANDBOX_TIMEOUT_MS` × calibrated ops-per-ms) and returns `true` to abort at the budget. Wall-clock `performance.now()` bounds the call outside the guest as the second, authoritative backstop. A `while(true){}` guest MUST produce a structured `timeout` result, never hang `wrangler dev`.

### Limits
[auto] Q: "Memory/stack?" → Selected: **`runtime.setMemoryLimit(SANDBOX_MEMORY_LIMIT)` (default 64 MiB) + `runtime.setMaxStackSize(1 MiB)`**, env-overridable, applied to every execution (recommended default).

### Guest surface
[auto] Q: "What can guest code touch?" → Selected: **zero host functions; an injected `console` (log/info/error captured with level + serialized args); nothing else** (recommended default). No fetch, no VFS, no host state; guests receive only their injected globals + JS builtins.

### Assertion harness
[auto] Q: "How do guests express the spec?" → Selected: **injected mini-harness: `test(name, fn)` registry + `expect(actual).toEqual(expected)` / `toBeTrue()` / `toBeCloseTo` / `assert(cond, msg)`** (recommended default). The sandbox collects `{name, passed, error?}` per test and returns them in the result — Phase 4's loop feeds failures back to the LLM. Guest code is a plain script; the harness runs registered tests after evaluation.

### Result contract
[auto] Q: "Result shape?" → Selected: **`{status: "ok"|"error"|"timeout"|"crash", logs: [{level, args}], tests: [{name, passed, error?}], result?, error?, ms}`** (recommended default). `error` = guest JS exception (evaluated fine, threw); `crash` = QuickJS/WASM abort (uncatchable); `timeout` = interrupt budget hit. Execution API: `execute(code: string): Promise<ExecuteResult>` behind a `SandboxRuntime` interface (seam symmetry with Typechecker; QuickJS impl is the only one in v1).

## Notes for downstream agents

- Phase 2 lesson applies directly: module init must not do heavy or clock-dependent work —
  QuickJS WASM loads lazily on first execution; healthz `sandbox` flips from "unloaded" to
  the variant identity after first load (same pattern as typechecker flip).
- Bundle math: +3.1MB embedded-WASM variant on top of the 11.2MB typescript bundle is fine
  for local dev (64MiB uncompressed worker limit; `bundle:check` still gates).
- The vitest-plugin transport limitation (Phase 2 discovery) holds for any spec importing the
  worker graph — sandbox tests belong in the `test:live` harness (assertions against POST
  /sandbox/... if exposed, or via a debug-only route if Phase 3 research recommends direct
  module tests under `vitest`... decision: extend `scripts/test-*.mjs` live harness pattern;
  do NOT import sandbox module into vitest worker graph).
- Phase 4 will call: `sandbox.execute(transpiledJs)` where transpiled JS comes from
  `ts.transpileModule` on the type-checked guest. Keep `execute()` input = JS string only.
