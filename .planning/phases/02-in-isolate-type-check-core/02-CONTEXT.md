# Phase 2 Context: In-isolate type-check core

**Phase:** 02 — In-isolate type-check core
**Captured:** 2026-10-11 (auto mode — all decisions are recommended defaults, logged for audit)

## Decisions

### TypeScript pin
[auto] Q: "Which compiler, pinned how?" → Selected: **typescript@6.0.3, exact pin, with a boot-time
assertion** (recommended default). Research tarball-verified 6.0.3 as pure JS (7.0.2 is native
tsgo — forbidden; it would silently break in-isolate checking). The worker asserts
`ts.version === "6.0.3"` (and that the createProgram API exists) on first load so an accidental
upgrade fails loudly, not silently.

### lib .d.ts delivery
[auto] Q: "How do lib files reach the in-isolate checker?" → Selected: **wrangler Text rules**
(`rules: [{type: "Text", globs: ["**/*.d.ts"]}]`) importing the needed `lib.*.d.ts` files from
node_modules as strings into a VFS map; lib SourceFiles memoized across checks (recommended
default). Never rely on `ts.sys` or `getDefaultLibFileName` touching a filesystem — the host
serves every file, including libs, from the map. Lib set: es2022 full set + DOM-free minimal
core (decide exact set in research; small lib set = faster checks).

### CompilerHost shape
[auto] Q: "Host implementation?" → Selected: **fully hand-rolled Map-based CompilerHost, fresh
Program per check** (recommended default). `getSourceFile`/`fileExists`/`readFile` read the VFS
map; `writeFile` no-op; `getDefaultLibFileName` returns the in-map name. Guest files replaced
per check; lib SourceFiles memoized. Program creation per request (no incremental builder —
prototype clarity).

### Typechecker seam
[auto] Q: "Interface shape?" → Selected: **`Typechecker` interface: `check(files: Map<string,string>): Promise<TypecheckResult>`**
with `{ok, diagnostics: [{code, message, line, column, file}], ms}`; `TsTypechecker implements
Typechecker` in-isolate (recommended default). The interface is the documented tsc-rs drop-in
seam (tsc-rs has no WASM build today — PROJECT.md Out of Scope; Phase 4's /typecheck benchmark
endpoint sits on this seam).

### Init strategy
[auto] Q: "When does the checker load?" → Selected: **lazy module-level singleton** (recommended
default). First request that needs it pays load+parse cost; later requests reuse memoized lib
SourceFiles. healthz `typechecker` flips from "unloaded" to `typescript@6.0.3 (in-isolate)`
after first load — identity is observable per RUN-02's pattern.

### Diagnostics contract
[auto] Q: "Diagnostic shape?" → Selected: **flat `{code, message, line, column, file}`, 1-based,
sorted by (file, line, column)** (recommended default). Category (error/warning) folded into
`ok` computation: any error-category diagnostic → `ok: false`. Squash TS2318-style lib noise by
construction (libs come from our map, so they always resolve).

### Timing fidelity
[auto] Q: "How are type-check times measured?" → Selected: **`performance.now()` deltas around
each check inside the worker, recorded per request and logged as `typecheck_ms`** (recommended
default). Phase 1 established wall-clock behavior; a micro sanity-check (two back-to-back
checks, second ≤ first + noise) goes in the tests so the numbers in Phase 4's benchmark are
honest.

## Notes for downstream agents

- Phase 1 findings that bind here: no_nodejs_compat is ACTIVE (typescript's
  `isNodeLikeSystem()` must stay false — verified assumption from STACK research);
  `Date.now()` frozen in global scope — any init timing uses `performance.now()` inside
  request scope.
- The checker is exercised via a `TypecheckService`-free minimal path: `src/typecheck.ts`
  exposes the interface + impl; `src/index.ts` POST /typecheck flips from 501 to a real
  response in Phase 4 (keep route registered; Phase 2 may wire it as `{ok:true,data:{...}}`
  behind the same envelope if trivial — allowed but not required).
- Bundle-size note: typescript adds ~10MB to the worker bundle; `bundle:check` gate from
  Phase 1 must still pass (local dev limit is 64MiB — fine); assert no `node:` imports appear.
