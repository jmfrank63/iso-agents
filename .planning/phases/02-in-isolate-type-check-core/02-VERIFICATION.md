# Phase 2 Verification

**Verified:** 2026-10-12 by gsd-verifier (goal-backward re-verification of the codebase; all gates re-run, live spot-checks booted an independent `wrangler dev` on port 8799 with PID-file teardown — not the harness's own boot)

**Verdict:** DELIVERED

## Requirements table

| Req | Verdict | Evidence |
|---|---|---|
| TYPE-01 (in-isolate, pinned pure-JS TS, boot assert) | DELIVERED | Pin exact: `package.json:16` `"typescript": "6.0.3"` (literal, not a range; 7.x forbidden). Boot assert fails loudly: `src/typecheck/index.ts:36` `if (ts.version !== "6.0.3") throw` (negated-form assert, equivalent intent), plus API-shape check (`index.ts:42`, `createProgram`/`getPreEmitDiagnostics`) and lost-flag check (`index.ts:45`, `process` must be undefined — guards `no_nodejs_compat`). `wrangler.jsonc:11` carries both opt-out flags. Every green check implies the assert ran; `/healthz` reports the pinned version live (`typescript@6.0.3 (in-isolate)`, spot-checked). |
| TYPE-02 (fully in-memory host, bundled lib .d.ts strings, zero fs, real diagnostics) | DELIVERED | 57 lib `.d.ts` files shipped as Text-module strings: `src/typecheck/lib-imports.ts` (57 `^import lib` statements, 57 `"lib.` keys, `@ts-nocheck` header), loaded via wrangler rule `wrangler.jsonc:17`. Map-served hand-rolled host: `src/typecheck/host.ts:24-50` (`getSourceFile`/`fileExists`/`readFile` read `LIB_TEXT`/`guestFiles` maps; `writeFile: () => {}` at host.ts:40). Zero host filesystem access: grep for `fs` imports/`readFileSync` over `src/` → none. Real diagnostics live-verified: TS2322 `{code:2322, message:"Type 'string' is not assignable to type 'number'.", line:1, column:7, file:"/guest.ts"}` from in-workerd POST. |
| TYPE-03 (N-run latency stats) | NOT CLAIMED (correct) | Phase 4 requirement (REQUIREMENTS.md traceability: TYPE-03 → Phase 4). `src/index.ts:87-114` `handleTypecheck` performs exactly one check per request; no N-run loop, no min/median/mean anywhere. Correctly absent from Phase 2. |
| TYPE-04 (Typechecker interface seam) | DELIVERED | `src/typecheck/index.ts:27-30` `interface Typechecker { id; check(files: Map<string,string>): Promise<TypecheckResult> }` with tsc-rs seam comment (index.ts:22-26). Two implementations: `TsTypechecker` (index.ts:71) and `TranspileOnlyTypechecker` (index.ts:92, transpile-only/noop, always ok). `createTypechecker(kind)` factory (index.ts:108-110). Both compile against the same interface (`npm run check` exit 0). Caveat noted under Gaps: the second impl is never runtime-exercised by an automated gate (structural + tsc proof only; documented plan deviation in 02-02). |

## Success criteria table (ROADMAP Phase 2)

| SC | Verdict | Evidence |
|---|---|---|
| SC1 — pin decided by spike, locked in package.json with rationale; boot assert fails loudly on native TS; /healthz reports pinned version | DELIVERED | Pin 6.0.3 exact in `package.json:16`; rationale recorded in `.planning/phases/02-in-isolate-type-check-core/02-CONTEXT.md` (§TypeScript pin: 7.0.2 native tsgo forbidden) and in code comments (index.ts:32-34). Boot assert `src/typecheck/index.ts:35-50` throws on version/API/`process` drift. Live: `/healthz` `runtime.typechecker` = `"unloaded"` before any check → `"typescript@6.0.3 (in-isolate)"` after (flip observed this session on a fresh boot). |
| SC2 — curl-able POST /typecheck returns structured `{code, message, file, line}` from in-memory VFS + hand-rolled CompilerHost + lib .d.ts as bundled text, no host fs | DELIVERED | Route: `src/index.ts:152-153` → `handleTypecheck` (index.ts:87-114), VFS-rooted names (`/guest.ts`), 200 envelope `{ok:true, data:{ok, diagnostics, ms}}` even when `data.ok === false`. Single-run wall-ms (N-run stats correctly deferred to Phase 4). Live spot-checks (independent boot, actual JSON below): red guest → 2322/line 1/col 7; type-safe `Promise.all`+`Map`+`console.log` guest → `ok:true, diagnostics:[]` (proves lib closure + guest-globals). `grep` proves no fs access in `src/`; `node:` import forms = 0 in bundle. |
| SC3 — second trivial Typechecker implementation selectable, proving genuine seam | DELIVERED (with caveat) | `TranspileOnlyTypechecker implements Typechecker` (src/typecheck/index.ts:92-104), selectable via `createTypechecker("transpile-only")` (index.ts:108). Selectability evidence is structural: tsc-typed against the same interface + grep gate `new TranspileOnlyTypechecker()` = 1. Caveat: never exercised at runtime by any automated gate (the route pins the `"ts"` impl; vitest may not load the typescript graph per the documented WebSocket-1009 transport crash) — an explicitly documented plan deviation in 02-02, not a silent skip. |
| SC4 — timing micro-test: measured ms non-zero; lib SourceFiles memoized to bound isolate churn | DELIVERED | `performance.now()` deltas around createProgram+getPreEmitDiagnostics (`src/typecheck/index.ts:76,83`; 4 occurrences in file). CONTEXT locked decision refined the roadmap's "dual-clock" wording to performance.now()-only per check (`Date.now()` remains only for `uptime_s`, src/index.ts:126) — code conforms to the locked decision. Memoization: `src/typecheck/vfs.ts:21-34` `sourceFileCache` + `memoSourceFile`, applied to libs+globals at `host.ts:28,32`; guests re-parsed fresh (host.ts:37); cache bounded at 58 entries. Live ms values: red cold 191 ms, lib-sanity 52 ms — both > 0; harness asserts `second <= first + 100 ms` and both `< 2000` and both `> 0` (passed this session). |

## Objective gate re-runs (this session)

| Gate | Result |
|---|---|
| `npm run check` | exit 0 |
| `npm test` | exit 0 — 1 file, 2 passed / 0 failed (`test/runs.spec.ts`; no spec may pull the typescript graph per the documented vitest-plugin WebSocket-1009 crash) |
| `npm run bundle:check` | exit 0 — **Total Upload: 11246.87 KiB / gzip: 1777.82 KiB**; `ls dist-bundle \| grep -c 'lib\.'` → **57** (60 files total: + index.js, index.js.map, README.md) |
| `! grep -rEo 'node:[a-z_]+' dist-bundle/` | **exit 1 (pattern found)** — but inspection shows all 6 matches (`node:quic`, `node:sea`, `node:sqlite`, `node:test`, `node:test/reporters`) are string literals inside unenv's `exclusivelyPrefixedNodeCoreModules` stub-list data, not imports. Actual import forms in dist-bundle/index.js: `from "node:` = 0, `import("node:` = 0, `require("node:` = 0, bare `import "node:` = 0. Gate intent (no Node builtins imported) holds; the strict pattern as written has false positives. See Gaps. |
| `npm run test:live` | exit 0 — **42 `ok -` assertions, 0 `FAIL -`** (healthz pre-state unloaded, 404/405/501 routes, green/red/lib-sanity/memoization cases, 400 validation, 405 `allow: POST` header, identity flip, teardown) |
| package.json pin | `"typescript": "6.0.3"` — exact literal (line 16), not a range, not 7.x |
| Boot assert presence | `src/typecheck/index.ts:36` `ts.version !== "6.0.3"` throw (negated form of the protocol's `===` assert; fails loudly as required) |

## Live spot-check log (independent `wrangler dev` boot, port 8799, PID-file teardown)

Pre-state `GET /healthz` (fresh boot): `{"ok":true,"data":{"status":"ok","runtime":{"workerd":"Cloudflare-Workers","compatibility_date":"2026-09-01","typechecker":"unloaded","sandbox":"unloaded","instanceId":"676f09a3-a9c9-4a5f-8afa-e371297a1889","uptime_s":0,"userAgent":"Cloudflare-Workers"}}}`

| # | Request | Actual response |
|---|---|---|
| 1 | `POST /typecheck` `{"files":{"guest.ts":"const x: number = \"a\";\n"}}` | HTTP 200: `{"ok":true,"data":{"ok":false,"diagnostics":[{"code":2322,"message":"Type 'string' is not assignable to type 'number'.","line":1,"column":7,"file":"/guest.ts","category":"Error"}],"ms":191}}` — code 2322 ✓, line 1 ✓, column 7 ✓, data.ok false ✓, envelope ok true ✓, ms 191 > 0 ✓ |
| 2 | `POST /typecheck` type-safe guest: `Map` + `Promise.all` + `console.log`/async/reduce | HTTP 200: `{"ok":true,"data":{"ok":true,"diagnostics":[],"ms":52}}` — lib closure + guest-globals proven ✓ |
| 3 | `GET /healthz` (after ≥1 check) | `runtime.typechecker` = `"typescript@6.0.3 (in-isolate)"` — flip from `"unloaded"` observed ✓ |
| 4 | `GET /agent/run/123e4567-e89b-42d3-a456-426614174000` | HTTP 404: `{"ok":false,"error":{"code":"not_found","message":"run 123e4567-… not found","detail":{"id":"…","hint":"in-memory store; isolate restart clears it"}}}` ✓ (Phase 1 intact) |
| 5 | `DELETE /healthz` | HTTP 405: `{"ok":false,"error":{"code":"method_not_allowed","message":"DELETE /healthz not allowed; use GET /healthz"}}` + `Allow: GET` header ✓ (Phase 1 intact) |
| 6 | `POST /agent/run` `{}` | HTTP 501: `{"ok":false,"error":{"code":"not_implemented","message":"POST /agent/run is registered but not implemented yet"}}` ✓ (Phase 1 intact) |
| 7 | `GET /nope` | HTTP 404: `{"ok":false,"error":{"code":"not_found","message":"no route for GET /nope"}}` ✓ (Phase 1 intact) |
| 8 | `GET /healthz` envelope (step 0 above) | HTTP 200 `{"ok":true, data:{status:"ok", runtime:{…}}}` ✓ (Phase 1 intact) |

Teardown: process-group SIGTERM via PID file → port 8799 closed (`curl` refused), no workerd processes remain. Timing observed this session: red cold **191 ms** (02-01: 230, 02-02: 211, research ≈ 223 — same band), lib-sanity guest **52 ms**.

## Locked-decision conformance (02-CONTEXT.md)

- **Text rule**: `wrangler.jsonc:17` `"rules": [{ "type": "Text", "globs": ["**/*.d.ts"], "fallthrough": true }]` — exact shape, `fallthrough: true` present. ✓
- **No `lib:` compiler option**: `grep -E '^\s*lib\s*:' src/typecheck/host.ts` → **0**; rationale documented at host.ts:4-8 (with `lib` set, typescript bypasses `getDefaultLibFileName`). ✓
- **`getDefaultLibFileName` bare key**: host.ts:39 `() => "lib.es2022.d.ts"` — a `LIB_TEXT` map key (bare basename shape per vfs.ts:4-7). ✓
- **Lib SourceFiles memoized**: `vfs.ts:21-34` module-level `sourceFileCache` + `memoSourceFile`; host.ts:28 (globals) and :32 (libs) memoize; guest files parsed fresh per check (host.ts:37); 58-entry steady state. ✓
- **Fresh Program per check**: `src/typecheck/index.ts:77-81` — `ts.createProgram` inside `check()`; no incremental builder. ✓
- **Diagnostics mapper**: 1-based (`index.ts:60-61`, `+1`), `flattenDiagnosticMessageText` for chained messageText (index.ts:59), sorted by (file, line, column) via `byLocation` (index.ts:67-69, applied at :84); file-less/start-less diags → line/column −1 sentinel (index.ts:53-56). ✓
- **performance.now deltas**: index.ts:76/83 around the check; route-level request timing at src/index.ts:139/143. `Date.now()` confined to `uptime_s` (src/index.ts:126) per the locked init-timing finding. ✓
- **Typechecker interface, two impls**: `Typechecker` (index.ts:27), `TsTypechecker` (index.ts:71), `TranspileOnlyTypechecker` (index.ts:92), `createTypechecker(kind)` (index.ts:108). ✓
- **Lazy singleton**: index.ts:116-124 — boot assert + construction on first `getTypechecker()`; `getTypecheckerIdentity()` (index.ts:126-128) never triggers init — live-proven: `/healthz` reported `"unloaded"` on a fresh isolate. ✓

## Gaps

1. **Strict bundle grep pattern false-positives (cosmetic, not a deliverable defect):** `! grep -rEo 'node:[a-z_]+' dist-bundle/` exits 1. The matches are six string literals (`node:quic`, `node:sea`, `node:sqlite`, `node:test`, `node:test/reporters` ×2 files incl. the sourcemap) inside unenv's `exclusivelyPrefixedNodeCoreModules` stub-list — module-name data, not imports. All actual import/require forms referencing `node:` in the bundle: 0. The Phase-1 gate's intent (no Node builtins imported) holds; only the verification protocol's grep pattern is too broad. No code change required; the pattern should exclude string-data allowlists or target import syntax.
2. **`TranspileOnlyTypechecker.check()` is never runtime-exercised by any automated gate** (only tsc type-checking + the count-1 grep). This is the 02-02 plan's explicitly documented deviation for the HTTP-unreachable half of SC3 — recorded here for honesty; the seam proof stands structurally. A one-line unit harness (small-module, no worker graph) could close it in a later phase if desired.

Otherwise: none. TYPE-03 correctly not claimed; all four Phase 2 success criteria delivered with live, re-run evidence.
