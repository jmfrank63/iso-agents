# Phase 3 Verification: QuickJS-WASM sandbox executor

**Verdict:** DELIVERED
**Verified:** 2026-10-12 (independent re-verification — all gates re-run, all live checks re-executed on a fresh `wrangler dev` boot; summaries not trusted)
**Method:** static gates re-run (`check`, `test`, `gate:no-host-eval`, `bundle:check`, greps), `npm run test:live` re-run end-to-end, plus an independent spot-check harness (`/tmp/verify-spotchecks.sh`) that booted its own `wrangler dev` instances (default env; and one with `--var SANDBOX_STACK_KB:1024` to probe the stack hard cap), with PID-based teardown and port-freed verification.

## Requirements table

| Req | Requirement (REQUIREMENTS.md) | Verdict | Evidence |
|---|---|---|---|
| SAND-01 | Generated JS executes inside QuickJS-WASM in the same isolate; no host `eval`/`new Function` anywhere | **DELIVERED** | `npm run gate:no-host-eval` exit 0; manual `grep -rnE '\beval\(|new Function\(' src/` → 0 matches. Execution path is QuickJS only: `newQuickJSWASMModuleFromVariant` + `context.evalCode` (src/sandbox/runtime.ts:63-70, 189, 199). Bundle emits exactly 1 `.wasm` sibling (QuickJS in the worker bundle). |
| SAND-02 | Execution deadline (interrupt, since `Date.now()` freezes) + memory limit | **DELIVERED** | Wall-clock interrupt primary + op-counter backstop (src/sandbox/runtime.ts:178-186); memory limit 64 MiB default (src/sandbox/limits.ts:19, runtime.ts:176). Live: `while(true){}` → `{"status":"timeout","error":"execution exceeded the 2000ms sandbox deadline"}` wall 532 ms (own boot) / 834 ms (test:live run); `while(true)` + 256 M-char alloc → catchable `InternalError: out of memory` (test:live case 7). |
| SAND-03 | Guest console captured and returned; guest cannot reach host state, fetch, or VFS | **DELIVERED** | Only injected surface is `console` (log/info/warn/error) — src/sandbox/runtime.ts:111-136; assertion harness is injected as guest-side SOURCE, not host functions (src/sandbox/harness.ts, eval'd at runtime.ts:189); no fetch/VFS handles crossed. Live: `console.log("answer",42)` → `logs:[{level:"log",args:["answer",42]}]`; object arg and `Error` → `{name,message}` dumps captured (test:live case 2, all 5 assertions pass). |
| SAND-04 | Fresh single-use context per execution; crashed guests cannot poison later runs | **DELIVERED** | `module.newContext()` per execute = fresh runtime owned by the context (runtime.ts:170); `dispose()` in its own try/catch inside `finally` (runtime.ts:240-249); abort counter rebuilds the module singleton after 3 (runtime.ts:65-66, 251-254). Live: green run ok after timeout, after stack overflow, and after a 128 KiB-capped recursion crash-class probe (spot-check boot B: `error` then `{"status":"ok","result":42,"tests":2}`). |

## Success criteria table (ROADMAP Phase 3)

| SC | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | `while(true){}` → structured timeout via counter-based interrupt + deadline; `wrangler dev` never hangs | **DELIVERED** | Live (own boot): HTTP 200, `status:"timeout"`, wall **532 ms** ≤ deadline+250 ms bound (2250 ms). test:live run: wall **834 ms**, `wrangler dev` survived, subsequent executions green. 03-02 recorded 776/772 ms — consistent across 4 independent runs. Note: for an *empty* `while(true){}` the op backstop (4×2000 = 8000 handler calls, runtime.ts:185) fires before the wall clock (~530-840 ms ≪ 2000 ms); wall-clock primary engages for heavier per-op guests. Status mapping and survival are correct either way. |
| 2 | Memory + stack limits enforced; crashed/overflowing guest cannot poison the next execution | **DELIVERED** | `setMemoryLimit(64 MiB)`, `setMaxStackSize(64 KiB)` with **code-level hard cap 128 KiB** via `Math.min` (limits.ts:20-21,39) — env overrides above 128 KiB are clamped, so the native-stack-blow poison class (>128 KiB, research row 8) is unreachable by configuration. Live: recursion → catchable `InternalError: stack overflow` (status `error`); requesting `SANDBOX_STACK_KB=1024` still executes at 128 KiB (clean `stack overflow`, no crash) — the cap confirmed live. Green run ok after each. |
| 3 | Console captured and returned; zero host functions exposed except injected console/assert | **DELIVERED** | Code audit: sole host-function injection is the console object (runtime.ts:111-136); `assert`/`expect`/`test` ship as guest-side source (harness.ts). Live: 3 console entries captured with levels + primitive/object/Error args (test:live case 2: 5/5 assertions). |
| 4 | CI/grep gate proves no host `eval`/`new Function` in the shipped worker | **DELIVERED** | `npm run gate:no-host-eval` (`! grep -rnE '\beval\(|new Function\(' src/`, package.json:13) exit 0; manual grep 0 matches. Bundle also free of real `node:` imports (0 `from/require/import("node:…")` hits in dist-bundle/index.js; the raw `node:` grep hits are typescript diagnostic identifier strings). |
| 5 | In-sandbox assertion harness returns structured `{name, pass, error}`; transpiled TS guest executes end-to-end | **DELIVERED** | Live: `[{"name":"adds","passed":true},…]`; failing assertion → `{"name":"broken on purpose","passed":false,"error":"Error: expected 3, got 2"}` with the later test still running. Transpiled TS guest (`ts.transpileModule` → sandbox): `status ok`, assertion passes, completion value 36 (test:live case 9). Harness-side transpile is the pre-Phase-4 shape; in-worker transpile lands with CORE-02 as planned. |

## Live spot-check log (actual JSON + timings)

Independent boot A (free port 39553, `CI=true npx wrangler dev`, PID-file teardown):

- Pre-state `GET /healthz` → `data.runtime.sandbox = "unloaded"` ✅
- Passing spec POST `/sandbox/execute`:
  ```json
  {"ok":true,"data":{"status":"ok","logs":[{"level":"log","args":["hi",42]}],
   "tests":[{"name":"adds","passed":true},{"name":"truthy","passed":true}],
   "result":42,"ms":32}}
  ```
  ms>0 ✅, logs captured ✅
- Failing assertion: `{"status":"ok","tests":[{"name":"broken on purpose","passed":false,"error":"Error: expected 3, got 2"},{"name":"still runs","passed":true}]}` ✅
- `while(true){}`: `{"status":"timeout","error":"execution exceeded the 2000ms sandbox deadline"}`, wall **532 ms** ≤ 2250 ms ✅
- Infinite recursion: `{"status":"error","error":"InternalError: stack overflow"}` — catchable, not a crash ✅; green run afterwards still `ok` ✅
- Async gate: `{"status":"error","error":"async execution is not supported in the sandbox (documented limitation): source contains \"async\""}`; `new Promise(...)` → `…source contains "Promise"` ✅
- Identity flip: `{"typechecker":"typescript@6.0.3 (in-isolate)","sandbox":"quickjs-wasmfile-release-sync@0.32.0","compatibility_date":"2026-09-01"}` (combined boot C check after first use of each subsystem) ✅
- Phase 1/2 routes intact: `/healthz` envelope `data.status=ok`; `/typecheck` green `{"ok":true,"data_ok":true,"ms":190}`; `/typecheck` red `{"data_ok":false,"diag":{"code":2322,"message":"Type 'number' is not assignable to type 'string'.","line":1,"column":7,"file":"/guest.ts"}}`; `GET /typecheck` → 405 + `allow: POST`; `POST /agent/run` → **501**; `GET /agent/run/unknown` → **404** ✅

Independent boot B (`--var SANDBOX_STACK_KB:1024`, crash-class probe):

- Recursion at clamped 128 KiB: `{"status":"error","error":"InternalError: stack overflow"}` (cap confirmed live — hard cap prevents the poison class)
- Second run after the error-class guest: `{"status":"ok","result":42,"tests":2}` — no poisoning ✅

`npm run test:live` (chained, this verification run): **exit 0, 82 `ok -` assertions, 0 `FAIL -`** — typecheck harness 42 ok, sandbox harness 40 ok; while-true wall **834 ms**; both teardowns `ok - teardown: wrangler killed and port closed`. (03-02 recorded 776/772 ms on its two runs.)

Static gates (this verification run):

| Gate | Result |
|---|---|
| `npm run check` | exit 0 |
| `npm test` | **12 passed / 0 failed** (2 files: runs.spec 2 + sandbox-pure 10) |
| `npm run gate:no-host-eval` | exit 0; manual grep of src/ → 0 matches |
| `npm run bundle:check` | Total Upload **11,839.95 KiB / gzip 2,029.37 KiB** (matches 03-02; +593 KiB raw / +252 KiB gzip over Phase 2's 11,246.93/1,777.83 — research-predicted ≈+608/+254) |
| dist-bundle siblings | **1** `.wasm` (`02028007…-quickjs.wasm`), **57** `lib.` d.ts siblings, `index.js` + map; 0 real `node:` imports |
| `src/sandbox/quickjs.wasm` | 503,134 bytes, `cmp` byte-identical to `node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm` |
| `wrangler.jsonc` | `"type"` count = 1 (Phase 2 Text rule only — no wasm rule, per research gotcha 12) |

## Conformance bullets (locked decisions + 03-RESEARCH supersessions)

- **wasmfile variant + `newVariant({wasmModule})`**: `@jitl/quickjs-wasmfile-release-sync` import (runtime.ts:9), project-local precompiled `.wasm` (runtime.ts:16), `newVariant<QuickJSSyncVariant>(wasmfileVariant, { wasmModule })` (runtime.ts:63) — the workerd-legal no-runtime-codegen path. No singlefile import anywhere (only an explanatory comment at runtime.ts:13).
- **Stack 64 KiB default / 128 KiB hard cap**: limits.ts:20-21, enforced at parse with `Math.min` (limits.ts:39) so env overrides cannot re-introduce the poison class; live-confirmed with a 1024 KiB request.
- **Wall-clock interrupt + op backstop**: `performance.now() > deadline || ++ops > 4×timeoutMs` (runtime.ts:178-186) — the research correction to CONTEXT's counter-primary premise; deadline mapped to `timeout` via null-safe `isInterrupt` (runtime.ts:96-103, 203-205).
- **Fresh single-use contexts + dispose discipline**: `module.newContext()` per execute (runtime.ts:170); `dispose()` wrapped in its own try/catch inside `finally` so a dispose abort cannot mask the real cause (runtime.ts:240-249); abort counter → singleton rebuild after 3 (runtime.ts:251-254, research rows 8/9).
- **Memory 64 MiB**: `setMemoryLimit` default 64 MiB (limits.ts:19), applied before any guest code (runtime.ts:176); OOM live-verified as catchable `error`.
- **Console-only injection**: `injectConsole` is the entire host-function surface (runtime.ts:111-136), with per-handle dispose, 8 KiB soft cap, and Error→`{name,message}` dumps — live-verified.
- **Guest-side harness source**: `HARNESS_SOURCE` eval'd as guest source before the guest (harness.ts:9-46, runtime.ts:189) — the research-mandated shape (host-function harness silently passes failures); `__tests` read back post-eval, skipped on timeout (runtime.ts:219-233).
- **Static async gate**: `ASYNC_SOURCE_PATTERN = /\basync\b|\bawait\b|\bPromise\b/` pre-eval rejection (gate.ts:7, runtime.ts:155-166) — research row 12's requirement (Promise shadowing alone cannot block `async`); live-rejected with clear messages.
- **Status matrix mapping**: `ok`/`error`/`timeout`/`crash` contract (runtime.ts:44-56) with null-safe dump handling ("internal sandbox failure" synthesis, runtime.ts:82-94) — matches the research failure-mode matrix; all live observations landed in the predicted statuses.
- **Supersessions adopted, not the stale CONTEXT decisions**: variant (not singlefile), stack (not 1 MiB), deadline (wall-clock primary) — exactly the three corrections 03-RESEARCH mandates; CONTEXT's remaining decisions (fresh contexts, 64 MiB, console-only, guest-side harness, result contract) all present.

## Gaps

**None material.** All 4 requirements and all 5 success criteria are objectively verified DELIVERED.

Non-blocking observations (recorded for the audit trail, no action required):

1. **Empty-body `while(true){}` fires via the op backstop, not the wall clock** (~530-840 ms wall ≪ the 2000 ms deadline): an empty loop polls the interrupt handler far more often than the 2.1 calls/ms arithmetic-loop calibration, so `++ops > 8000` trips first. Status, structure, and the never-hangs guarantee are correct; the wall-clock primary still bounds heavier per-op guests. Both guards are by-design interrupt sources.
2. **`status:"crash"` is not reachable via configuration** — the 128 KiB hard cap (limits.ts:39) clamps `SANDBOX_STACK_KB` overrides, so the dispose-abort poison class cannot be produced by any env value (live-confirmed with 1024 KiB → clean catchable error). The crash code path (runtime.ts:234-249) exists and is structurally correct; no success criterion requires observing it.
3. Pre-existing stray `wrangler dev`/workerd processes from the earlier research spike (`/tmp/qjs-spike`, port 8799) were running before verification began; left untouched (not spawned by any project harness — same note as 03-02 Deviation 3). All verifier-owned boots were torn down by PID and their ports verified freed.
