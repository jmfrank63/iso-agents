# Plan 02-01 Summary: Core checker — Text-rule libs, Map VFS + Design-A host, Typechecker seam, route wiring

**Status:** DELIVERED (all 4 tasks executed sequentially; every verify gate passed; plan-level verification passed; live red/green confirmed in workerd)

**Executed:** 2026-10-12 by gsd-executor, against 02-01-PLAN rev 1 (review issues 1–6 already incorporated in the plan text).

## What was built

### Task 1 — Text rules + 57-lib generated imports
- `wrangler.jsonc`: appended `"rules": [{ "type": "Text", "globs": ["**/*.d.ts"], "fallthrough": true }]` after `observability` (with the required comment block); deleted the Phase-1 `// Phase 2 will append…` placeholder comment (it contained a literal `"type": "Text"` that would double-count the grep gate); both `no_nodejs_compat` flags and everything else untouched.
- `scripts/gen-lib-imports.mjs` (committed): BFS over `/// <reference lib="...">` chains from `lib.es2022.d.ts` in `node_modules/typescript/lib`, sorted output, deterministic identifiers.
- `src/typecheck/lib-imports.ts` (generated + committed): 57 imports, `LIB_FILES: Record<string, string>` map, `// @ts-nocheck` header (the only verified-clean shape — ambient shim is shadowed by real-file resolution).
- Ran the script twice: byte-identical output (deterministic).
- No bundle gates at this task, per review issue 4 (nothing imports lib-imports.ts yet; confirmed 0 lib siblings pre-wiring).

### Task 2 — Map VFS + memoized lib SourceFiles + Design-A CompilerHost
- `src/typecheck/vfs.ts`: `LIB_TEXT` (bare-basename map), `GUEST_GLOBALS = "/guest-globals.d.ts"` + console-declaring text, `memoSourceFile()` over a module-level SourceFile cache (57 libs + globals at steady state).
- `src/typecheck/host.ts`: `GUEST_COMPILER_OPTIONS` (strict/ES2022/noEmit/ESNext/Bundler/skipLibCheck/isolatedModules/forceConsistentCasing — **no `lib` option**, grep-gated to 0), `makeHost(guestFiles)` — fully map-served CompilerHost, `getDefaultLibFileName: () => "lib.es2022.d.ts"` (a LIB_TEXT key), no-op `writeFile`, memoized lib/globals + fresh guest SourceFiles.

### Task 3 — Typechecker seam + boot assert + mapper + impls + singleton
- `src/typecheck/index.ts`: `Typechecker`/`TypecheckResult`/`TypecheckDiagnostic` (flat, 1-based, category); `assertCompilerIdentity()` — `ts.version === "6.0.3"`, `createProgram`/`getPreEmitDiagnostics` typeof, `process` must be undefined (fails loudly on native-tsgo 7.x or lost `no_nodejs_compat`); `mapDiagnostic` (flattenDiagnosticMessageText, tolerant of file/start-less diags) + `byLocation` sort; `TsTypechecker` (fresh Program per check, `performance.now()` around createProgram+getPreEmitDiagnostics, `ok:false` iff any Error); `TranspileOnlyTypechecker` (TYPE-04 seam proof); `createTypechecker(kind)`; lazy singleton + `getTypecheckerIdentity()` ("unloaded" → `typescript@6.0.3 (in-isolate)` only after first use).

### Task 4 — Wire worker + spec relocation
- `src/index.ts`: import seam; `getRuntimeInfo().typechecker` → `getTypecheckerIdentity()`; 501 split (`POST /agent/run` stays 501, `POST /typecheck` → `handleTypecheck`); new `handleTypecheck` — 400 bad_request on non-JSON/no-files/empty-files/non-string values, VFS-rooted names (`"guest.ts"` → `"/guest.ts"`), `{ok:true,data:{ok,diagnostics,ms}}` at 200 even when `data.ok === false`.
- `test/healthz.spec.ts` DELETED (review issue 1: the vitest-plugin WebSocket transport crashes workerd with `statusCode = 1009; Message is too large` once the 8.8 MB typescript module is in the graph; reproduced 4× during review). Its six worker-dispatching assertions relocate 1:1 into the 02-02 live harness; the removed 501-/typecheck test becomes the 405 GET /typecheck + `allow: POST` assertion (review issue 6). `test/runs.spec.ts` (small-module, no `cloudflare:workers` import) untouched and green.

## Files + commits

| Commit | Task | Files |
|---|---|---|
| `0aacc96` | T1 | `wrangler.jsonc`, `scripts/gen-lib-imports.mjs`, `src/typecheck/lib-imports.ts` |
| `f2b3098` | T2 | `src/typecheck/vfs.ts`, `src/typecheck/host.ts` |
| `ec8bcbd` | T3 | `src/typecheck/index.ts` |
| `52eaeac` | T4 | `src/index.ts`, `test/healthz.spec.ts` (deleted) |

`.planning/` not committed; nothing pushed.

## Verification results

### Task gates
- **T1:** gen script exits 0, prints `57 imports`, byte-identical on re-run; `^import lib` = 57; `"lib\.` keys = 57; es2022/es5 key greps match; `@ts-nocheck` = 1; `"type": "Text"` = 1; `"fallthrough": true` = 1; `"typescript": "6.0.3"` pin present. 0 lib siblings in bundle at this point — expected (review issue 4), shipping gates asserted post-wiring below.
- **T2:** `tsc --noEmit` exit 0; LIB_TEXT/GUEST_GLOBALS/memoSourceFile greps match; `getDefaultLibFileName: () => "lib.es2022.d.ts"` matches; skipLibCheck/isolatedModules match; `^\s*lib:` count = 0; `writeFile: () => {}` matches; memoSourceFile count in host.ts = 3.
- **T3:** `tsc --noEmit` exit 0; all verbatim-content greps match; `getPreEmitDiagnostics` = 3; `performance.now()` = 4 (rev-1 corrected counts, review issue 5); mapper + singleton greps match.
- **T4:** `npm run check` exit 0; `test/healthz.spec.ts` absent; `npm test` → **2 passed / 0 failed** (`test/runs.spec.ts` only, small-module suite per review issue 1); all four src/index.ts greps match; `it(` count in runs.spec.ts = 2.

### Plan-level gate chain
1. `npm run check` → exit 0.
2. `npm test` → 2 passed / 0 failed.
3. `npm run bundle:check` → `Total Upload: 11246.87 KiB / gzip: 1777.82 KiB`; awk gate: `bundle KiB: 11246.87` (> 8192); `ls dist-bundle | grep -c 'lib\.'` → **57** (plus index.js, index.js.map, README.md = 60 files).
4. `! grep -qE "from ['\"]node:" dist-bundle/index.js` → **zero node: refs**.
5. Static trap greps: no `^\s*lib:` in src/typecheck/; `fallthrough` in wrangler.jsonc; 57 lib imports; `getDefaultLibFileName: () => "lib.es2022.d.ts"`; `ts.version !== "6.0.3"`; `GUEST_GLOBALS` in rootNames — all pass.

### Live POST /typecheck (wrangler dev, port 8787)
- Pre-state: `GET /healthz` → `runtime.typechecker: "unloaded"` (same `instanceId` throughout).
- **Red:** `POST /typecheck {"files":{"guest.ts":"const n: number = \"not a number\";\n"}}` →
  `{"ok":true,"data":{"ok":false,"diagnostics":[{"code":2322,"message":"Type 'string' is not assignable to type 'number'.","line":1,"column":7,"file":"/guest.ts","category":"Error"}],"ms":230}}` — HTTP 200, data.ok=false; column 7 matches the review's runtime-verified TS2322 offset (declared name, not initializer); cold 230 ms ≈ research's 223 ms.
- **Green:** clean `add(a,b)` guest → `{"ok":true,"data":{"ok":true,"diagnostics":[],"ms":17}}`; repeat → `ms:6` (research warm band 8–20 ms; second ≤ first).
- Post-state: `GET /healthz` → `runtime.typechecker: "typescript@6.0.3 (in-isolate)"` — identity flip observable.
- Error paths: `GET /typecheck` → 405 + `Allow: POST` header; `POST /agent/run` → 501 `not_implemented`; malformed JSON / `{"files":{}}` / non-string file value → 400 `bad_request` with distinct messages.
- Teardown: wrangler killed; port 8787 confirmed free; no workerd processes.

## Deviations

- None in file content or behavior: all four task actions were lifted verbatim from the rev-1 plan (which already carried review fixes 1–6).
- Operational note (not a deviation): the rules-mandated `pkill -f wrangler` self-matched the executing shell's own command line and hung it (the self-match gotcha 02-02's teardown is designed to avoid); a follow-up check confirmed wrangler was dead and port 8787 free.
- Pre-existing environment quirk: `/tmp/opencode` is not writable by this user (also noted in 02-PLAN-REVIEW.md); determinism check used `/tmp` instead.

## Explicitly NOT here (per plan)

- N-run latency stats (TYPE-03 → Phase 4), sandbox/QuickJS (Phase 3), agent loop (Phase 4), the live curl harness + in-workerd spec re-placement (`02-02`, wave 2).
