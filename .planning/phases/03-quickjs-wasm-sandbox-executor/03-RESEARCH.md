# Phase 3 Research: QuickJS-WASM sandbox executor

**Phase:** 03 | **Researched:** 2026-10-11 (empirically verified 2026-10-12)

> **Method:** npm registry + tarball inspection of `quickjs-emscripten-core@0.32.0`,
> `@jitl/quickjs-singlefile-browser-release-sync@0.32.0`, `@jitl/quickjs-wasmfile-release-sync@0.32.0`,
> `@jitl/quickjs-ffi-types@0.32.0` (packed, unpacked, `.d.ts` + minified module + FFI glue read),
> plus a full `/tmp/qjs-spike` wrangler-dev spike (wrangler 4.149.0 / workerd 1.20261006.1,
> same compat flags as this project) running 20 live cases against real workerd. Every claim
> below marked **[SPIKE]** was executed in real workerd, not just read from docs.

## Summary (opinionated)

**The locked variant decision is wrong and must be re-decided: the browser-singlefile variant cannot initialize under workerd.** Its WASM is embedded as a charcode string and instantiated with `WebAssembly.instantiate(bytes)` at runtime — workerd rejects runtime code generation with `CompileError: WebAssembly.instantiate(): Wasm code generation disallowed by embedder` **[SPIKE, blocking]**. The workerd-legal path is exactly PITFALLS #13's pattern: `@jitl/quickjs-wasmfile-release-sync` + a copy of `emscripten-module.wasm` (491 KB) in `src/`, imported as a CompiledWasm module (wrangler default rule — **no `rules` entry needed**), wired via `newVariant(variant, { wasmModule })`. This variant is also the one that actually carries the first-party `workerd` export condition (`emscripten-module.cloudflare.cjs`) that the STACK research attributed to variants generally. Cost: one copied 491 KB file (record why it exists — it must track the package version); benefit: **verified-working in real workerd, cold module init ~5 ms, bundle delta only ~608 KiB raw / 254 KiB gzip** — far under the +3.1 MB estimate in CONTEXT.md.

Two more empirical corrections to the locked context, both good news:

1. **The counter-based interrupt premise is outdated: `performance.now()` advances inside the interrupt handler during guest execution.** A 500 ms wall-clock deadline in the handler fired at 502 ms wall **[SPIKE]**. The handler is ordinary host code; workerd's frozen-`Date.now()` behavior (Phase 1 finding, global scope) does not apply to it. Recommendation: wall-clock check in the handler (simple, exact), keeping an invocation counter as a cheap secondary guard, plus a boot-time live-harness assertion that a `while(true)` guest returns `timeout` in ≈ deadline + ε. Calibration (ops/ms ≈ 2.1, measured, linear across 1M–10M-iteration workloads **[SPIKE]**) is only needed if the team still prefers the counter as primary — it works too (500 ms budget → 614 ms wall).
2. **`setMaxStackSize` must be ≤128 KB, not 1 MiB.** At 1 MiB and 320 KB the guest's native WASM stack blows before QuickJS's JS-level check: the host gets a `RangeError: Maximum call stack size exceeded` out of `evalCode`, and a subsequent `context.dispose()` aborts with `Aborted(Assertion failed: list_empty(&rt->gc_obj_list) … JS_FreeRuntime)` **[SPIKE — the exact PITFALLS #4 poison, reproduced]**. At 64 KB and 128 KB the guest gets a catchable `InternalError: stack overflow` and dispose is clean **[SPIKE]**. Default 64 KB (env-overridable), never above 128 KB.

Also empirically settled: memory-limit exceed is a **catchable** `InternalError: out of memory` (guest can catch it; host sees `status: "error"`; dispose stays clean) both for totals (object churn, 32 MiB limit) and single huge allocations (256 MB string vs 64 MiB limit) **[SPIKE]**; the guest **cannot** escape the deadline by catching the interrupt (host still receives `InternalError: interrupted`) **[SPIKE]**; long built-ins **do** poll the interrupt handler in the vendored 2025-09-13 QuickJS (issue #219's absolute claim no longer holds — 1,467 handler calls observed during a single 11.4 s `String.replace`) but termination after budget exhaustion inside a built-in is **delayed** (worst observed: 7.2 s from a zero budget) **[SPIKE]**; the dispose-abort is host-catchable, the module singleton **survives it**, and a fresh module instance rebuilds in ~3 ms **[SPIKE]** — crash containment is achievable, not fatal.

Everything else in the locked context survives verification intact: fresh `module.newContext()` per execution (it creates a **fresh runtime owned by the context** — one `dispose()` tears down both), `executePendingJobs` only matters for promises, completion values work, console capture via host-side `dump` is robust (Errors → `{name, message, stack}`, circulars → `"[object Object]"`, no crash), and the harness must be injected as **guest-side source** because `context.throw()` from a host function does not propagate into the guest's call stack **[SPIKE — the host-function harness silently recorded a failed assertion as passed]**.

## Verified API Facts (signatures from packed .d.ts, with file refs)

All from `quickjs-emscripten-core@0.32.0` tarball (npm, `time.modified` 2026-02-16); file refs are `dist/index.d.ts` inside the packed package unless noted.

| Fact | Signature / evidence | Ref |
|---|---|---|
| Interrupt handler type | `type InterruptHandler = (runtime: QuickJSRuntime) => boolean \| undefined \| void;` — returns truthy to interrupt. **No `"terminate"` variant exists in 0.32.0.** | index.d.ts:174 |
| `setInterruptHandler` | `setInterruptHandler(cb: InterruptHandler): void` (+ `removeInterruptHandler(): void`). JS side stores cb and calls `QTS_RuntimeEnableInterruptHandler(rt)`; C polls it via the `i:(a,d)=>{return c.callbacks.shouldInterrupt(void 0,a)}` import. | index.d.ts:287; wasmfile dist `emscripten-module.cloudflare.cjs` |
| `shouldInterruptAfterDeadline` | `declare function shouldInterruptAfterDeadline(deadline: Date \| number): InterruptHandler;` — implementation is literally `function(){ return Date.now() > deadlineAsNumber }` (host clock in handler — same mechanism we validated). | index.d.ts:1918; dist/index.mjs |
| `setMemoryLimit` | `setMemoryLimit(limitBytes: number): void` — "To remove the limit, set to `-1`." | index.d.ts (~:310) |
| `setMaxStackSize` | `setMaxStackSize(stackSize: number): void` — "To remove the limit, set to `0`." (The doc-recommended 320 KB–1 MB range **overruns the native WASM stack in this build** — see Failure-Mode Matrix.) | index.d.ts:333 |
| `executePendingJobs` | `executePendingJobs(maxJobsToExecute?: number \| void): ExecutePendingJobsResult` where `ExecutePendingJobsResult = DisposableResult<number, QuickJSHandle & { context }>`. Default `-1` = run all. Plus `hasPendingJob(): boolean`. | index.d.ts:183–197 (Runtime class) |
| Module factory | `newQuickJSWASMModuleFromVariant(variantOrPromise: PromisedDefault<QuickJSSyncVariant>): Promise<QuickJSWASMModule>`; `newVariant<T extends QuickJSVariant>(baseVariant: T, options: CustomizeVariantOptions): T`. | index.d.ts:1830–1834, 1910 |
| `CustomizeVariantOptions.wasmModule` | `wasmModule?: OrLoader<WebAssembly.Module>` — "Emscripten will instantiate the WebAssembly.Instance from this existing WebAssembly.Module". Implementation wires `moduleLoaderArg.instantiateWasm` → `WebAssembly.instantiate(precompiledModule, imports)` — **no runtime codegen, the workerd-legal path**. | index.d.ts:1868–1880; core dist/index.mjs `newVariant` |
| `module.newContext()` | `newContext(options?)` on `QuickJSWASMModule` creates `newRuntime()` **then** `runtime.newContext({...options, ownedLifetimes: [runtime, …]})` — **fresh runtime per call, owned by the context; one `context.dispose()` frees both**. | core dist/chunk-V2S4ZYJR.mjs |
| `evalCode` | `evalCode(code: string, filename?: string, options?: number \| ContextEvalOptions): QuickJSContextResult<QuickJSHandle>` — "returns the last statement's value … If execution was interrupted, the error will have name `InternalError` and message `interrupted`." `ContextEvalOptions = { type?: "global" \| "module"; strict?; strip?; compileOnly?; backtraceBarrier? }`. | index.d.ts:1512–1549, 590–610 |
| Host↔guest value API | `newString(value: string)`, `newObject(prototype?)`, `newFunction(name?: string, fn: VmFunctionImplementation<QuickJSHandle>)`, `getProp(handle, key: string \| QuickJSHandle): QuickJSHandle`, `setProp(handle, key, value): void`, `getString(handle): string`, `getNumber`, `typeof(handle): string`, `getLength(handle): number \| undefined`, `callFunction(func, thisVal, ...args): VmCallResult<QuickJSHandle>`, `throw(error): JSValuePointer` ("@experimental"), `unwrapResult(result)`, `dump(handle): any` ("best-effort … Returns `handle.toString()` if it cannot be serialized to JSON"). | index.d.ts:1117–1407, 1562–1572 |
| Variant descriptor | `QuickJSSyncVariant = { type: "sync"; importFFI(): Promise<FFI class>; importModuleLoader(): Promise<EmscriptenImport> }` — lazy dynamic `import()`s, all ESM. | ffi-types dist/index.d.ts:527–531 |
| Versions / registry | `quickjs-emscripten-core@0.32.0` (dist-tags: latest 0.32.0, next 0.26.1-rc.0; modified 2026-02-16); `@jitl/quickjs-singlefile-browser-release-sync@0.32.0`; `@jitl/quickjs-wasmfile-release-sync@0.32.0`; `@jitl/quickjs-ffi-types@0.32.0` (sole dep of core). **`@jitl/quickjs-wasmfile-browser-release-sync` does not exist** — the CONTEXT fallback name is wrong; the real fallback/successor is `@jitl/quickjs-wasmfile-release-sync`. | npm view, 2026-10-12 |
| Singlefile internals | `index.mjs` (298 B) → lazy `import("./ffi.mjs")` + `import("./emscripten-module.browser-XIKQQPVU.mjs")` (828 KB). The module contains **zero** `require(`/`node:`/`fs`/`process`/`fetch` references and zero `instantiateStreaming`; WASM is a charcode string decoded via `charCodeAt` into a `Uint8Array`, then `WebAssembly.instantiate(bytes, imports)` — **runtime codegen, rejected by workerd**. Exports map is unconditional `types/import/default` (plus `browser` on `./emscripten-module`) — **no `workerd` condition on the singlefile package**. | singlefile packed dist/, grep-verified |
| Wasmfile internals | exports: `.` (ESM), `./ffi`, **`./wasm` → `./dist/emscripten-module.wasm` (491 KB)**, `./emscripten-module` with conditions `iife`/`workerd` (→ `emscripten-module.cloudflare.cjs`, 9.3 KB CJS)/`browser`/`import`/`require`. The cloudflare module's default loader **fetches** `./emscripten-module.wasm` at runtime (`fetch(a, {credentials:"same-origin"})` → fails in workerd) but honors the standard `instantiateWasm` hook — so **`newVariant({ wasmModule })` is required even with the workerd-condition module**. | wasmfile packed package.json + dist/emscripten-module.cloudflare.cjs |

## Failure-Mode Matrix (guest condition → observable host behavior → status mapping)

All rows verified in real workerd (wrangler 4.149.0 / workerd 1.20261006.1, compat `2026-09-01`, `no_nodejs_compat` + v2) unless noted.

| # | Guest condition | Host observes | Guest observes | Mapped status | Notes |
|---|---|---|---|---|---|
| 1 | `while(true){}` arithmetic, 500 ms wall-clock handler | `evalCode` returns error handle; wall 614 ms (budget 500) | `InternalError: interrupted` (uncatchable in practice, see #2) | `timeout` | **ROADMAP success criterion SAND-1 verified.** Handler ≈1.7–2.1 calls/ms (linear: 201 calls/96 ms at 1M iters, 2001/944 ms at 10M). |
| 2 | Guest `try{while(1){}}catch(e){…}` (catches the interrupt) | Still `InternalError: interrupted` at host; wall 56 ms | The catch did not yield a usable continuation | `timeout` | **Interrupt escape via catch is not possible** — the interrupt re-fires on subsequent polls. Timeout status is robust. |
| 3 | Budget exhausted *inside* a long built-in (`"x".repeat(2e7).replace(/x/g,"y")`, zero budget) | `timeout` at wall 7,232 ms (vs 0.5 ms "budget") | — | `timeout` | Built-ins **do poll** the handler in vendored quickjs 2025-09-13 (issue #219 softened), but unwinding out of a built-in is **delayed** — worst observed overshoot ≈ 14× deadline. |
| 4 | Long built-in, generous budget | Completes; handler was invoked 1,467× during an 11.4 s `String.replace` | normal completion | `ok` | Residual risk: a guest that reaches budget inside a multi-second built-in returns late (bounded by built-in duration). Keep guest sources + inputs small. |
| 5 | Object churn past `setMemoryLimit(32 MiB)`: `for(;;) a.push({x:new Array(64).fill(0)})` | `evalCode` returns **success** with completion value (guest caught it) | catchable `InternalError: out of memory` | `error` (with guest-caught info) | Total accounting enforced for objects; wall 2,955 ms; **dispose clean afterwards**. |
| 6 | Single huge alloc past limit: `"x".repeat(2**28)` vs 64 MiB limit | error handle; wall 1 ms | `InternalError: out of memory` | `error` | Single-allocation refusal is instant. |
| 7 | Deep recursion, `setMaxStackSize(64 KB)` or `128 KB` | error handle; **dispose OK, no abort** | catchable `InternalError: stack overflow` | `error` | The safe zone. 128 KB verified OK; boundary is between 128 KB and 320 KB (native WASM stack ≈ 256 KB class). |
| 8 | Deep recursion, `setMaxStackSize(320 KB)` or `1 MiB` | `evalCode` **throws** host `RangeError: Maximum call stack size exceeded`; then `context.dispose()` throws `RuntimeError: Aborted(Assertion failed: list_empty(&rt->gc_obj_list) … JS_FreeRuntime)` | nothing usable | `crash` | **PITFALLS #4 reproduced exactly.** The JS-level stack check never fires; native stack blows first. The abort is a catchable host JS exception (try/catch around `evalCode` and around `dispose()` separately). |
| 9 | After a #8 abort | Same module singleton still creates working contexts (`6*7` → 42); a brand-new module from the same precompiled `WebAssembly.Module` builds in **3 ms** and works | — | containment, not brick | The aborted `JS_FreeRuntime` **leaks** that runtime's heap into the module permanently. Policy: count aborts; after N (e.g. 3) rebuild the module singleton (cheap) and keep serving. |
| 10 | Built-in failure without JS exception (20 M-char global regex replace) | error handle whose `dump()` is **`null`** | — | `error` (synthetic message) | Always guard `dump(error)` — treat null/unserializable as `"internal sandbox failure"`; never assume `error.name` exists. |
| 11 | Guest `new Promise()` with shadowed global | error `TypeError: Promise is not a constructor` (host fn can't be `new`ed) | catchable | `error` | Shadowing blocks explicit `new Promise` only. |
| 12 | Guest `async function`/`await` despite shadowed global | **still works** (internal promise machinery, not the global); jobs queue until pumped | promise handle returned | `error` only if source-gated | **Promise shadowing cannot enforce sync-only guests — a source gate (reject `async`/`await` tokens post-transpile) is mandatory** (matches PITFALLS #7). |
| 13 | Guest registers promise job then script ends (`Promise.resolve().then(...)`); host does **not** pump | `evalCode` returns completion value `0`; `hasPendingJob()===true`; job never ran | — | n/a (forbidden) | Jobs only run via `executePendingJobs()` → 1 executed, then value `1` visible. Confirms: guests are sync; no pump needed in the happy path. |
| 14 | `console.log` with arbitrary args incl. `Error`, circular object | host fn receives handles; `dump` per arg: `42`, `{a:[1,2,3]}`, `{name,message,stack}`, circular → `"[object Object]"`; no crash | — | `ok` | Recommended capture pattern works. Cap buffer (~8 KB, PITFALLS minor). |

## Recommended Implementation (concrete)

### `src/sandbox/runtime.ts` shape

```ts
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSWASMModule, type QuickJSSyncVariant } from "quickjs-emscripten-core";
import wasmfileVariant from "@jitl/quickjs-wasmfile-release-sync";
import wasmModule from "../quickjs.wasm"; // copied from the package, see below

const variant = newVariant<QuickJSSyncVariant>(wasmfileVariant, { wasmModule });

// lazy singleton; ~5ms cold, survives guest aborts
let modulePromise: Promise<QuickJSWASMModule> | undefined;
let abortCount = 0;
function getModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  return modulePromise;
}

// SandboxRuntime interface (seam symmetry with Typechecker)
export interface SandboxRuntime {
  execute(code: string): Promise<ExecuteResult>;
}
export interface ExecuteResult {
  status: "ok" | "error" | "timeout" | "crash";
  logs: Array<{ level: string; args: unknown[] }>;
  tests: Array<{ name: string; passed: boolean; error?: string }>;
  result?: unknown;
  error?: string;
  ms: number;
}
```

`execute()` skeleton — **every handle and every failure path in its own try/catch; context dispose guarded separately from eval**:

```ts
const context = module.newContext();          // fresh runtime + context, runtime owned by context
try {
  context.runtime.setMemoryLimit(memLimitBytes);        // default 64 MiB, env SANDBOX_MEMORY_LIMIT_MB
  context.runtime.setMaxStackSize(stackBytes);          // default 64 * 1024, HARD CAP 128 * 1024
  const deadline = performance.now() + timeoutMs;       // env SANDBOX_TIMEOUT_MS, default 1000
  let ops = 0;
  context.runtime.setInterruptHandler(() =>
    performance.now() > deadline || ++ops > OPS_BACKSTOP);  // wall clock primary, counter secondary

  injectConsole(context, logs);        // host newFunction per level; dump() each arg handle; dispose handles; cap 8KB
  const harnessReady = context.evalCode(HARNESS_SOURCE);  // guest-side test/expect/assert; dispose handle
  const result = context.evalCode(code, "guest.js", { type: "global", strict: true });
  if (result.error) {
    const e = context.dump(result.error); result.error.dispose();   // dump may be null -> synthetic message
    status = (e?.name === "InternalError" && String(e?.message).includes("interrupted")) ? "timeout" : "error";
  } else {
    value = context.dump(result.value); result.value.dispose();      // plain JSON-able data only
  }
  // then: pump test fns? NO — HARNESS_SOURCE auto-runs registered tests at the end of eval,
  // pushing into a guest array; read it via getProp(global, "__tests") + dump + dispose.
  status ??= "ok";
} catch (err) {
  status = "crash"; error = `${err?.name}: ${err?.message}`; abortCount++;
} finally {
  try { context.dispose(); } catch (e) {     // dispose can abort even when eval didn't (row 8)
    status = "crash"; error ??= `dispose: ${e?.message}`;
    abortCount++;
  }
}
if (abortCount >= 3) { modulePromise = undefined; }  // rebuild module singleton on next execute (~3ms)
```

### Variant + wasm mechanics (the re-decided part)

1. `npm i quickjs-emscripten-core@0.32.0 @jitl/quickjs-wasmfile-release-sync@0.32.0` (deps only; `@jitl/quickjs-ffi-types` comes transitively).
2. Copy `node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm` → `src/quickjs.wasm` with a header comment: version-pinned copy, regenerate on package bump. **No `rules` entry needed** — wrangler's default `CompiledWasm` rule covers `**/*.wasm` for project files (verified; an explicit `{type:"CompiledWasm"}` rule is also legal but redundant, and rule types are `CompiledWasm`/`Text`/`Data` — `"Wasm"` is rejected by wrangler 4 config parsing). **The rule does not reach `node_modules/`** — importing `@jitl/quickjs-wasmfile-release-sync/wasm` fails with `No loader is configured for ".wasm" files` — hence the copy.
3. `newVariant(wasmfileVariant, { wasmModule })` — required; without it the cloudflare-condition module loader `fetch()`es the wasm path at runtime and dies in workerd.
4. Bundle delta measured: **608 KiB raw / 254 KiB gzip total** for a worker already containing the sandbox (spike dry-run). The `.wasm` is emitted as a separate asset next to `index.js`. Well under the 64 MiB limit; `bundle:check` keeps gating.

### Interrupt deadline (simplified from CONTEXT decision)

- Primary: `performance.now()` wall-clock inside the handler — **verified to advance during guest execution** (500 ms deadline → fired at 502 ms wall). Keep the CONTEXT `SANDBOX_TIMEOUT_MS` env name.
- Secondary: invocation counter backstop (e.g. `OPS_BACKSTOP = 4×timeoutMs` at the measured ≈2.1 calls/ms — pure paranoia against a future workerd making `performance.now()` static).
- Boot-of-isolate calibration/verification belongs in the live harness: assert `while(true){}` → `timeout` in < deadline + 1 s. If a future runtime freezes `performance.now()` in the handler, fall back to counter-primary with boot-time calibration (`opsPerMs ≈ 2.1` measured; re-measure with a 1M-iteration guest, budget = `SANDBOX_TIMEOUT_MS × opsPerMs`).

### Console injection

`context.newFunction("log", (...argHandles) => { logs.push({level, args: argHandles.map(h => { const d = context.dump(h); h.dispose(); return d; })}) })` per level (`log`/`info`/`warn`/`error`) on a `console` object set via `setProp(context.global, "console", consoleObj)`; dispose each fn handle and the console object handle after `setProp` (`setProp` dups). Verified robust for primitives, objects, Errors (`{name, message, stack}` — great LLM feedback), circular objects (toString fallback). Cap `logs` at ~8 KB.

### Harness injection + guest-side runner

Inject **as guest source** in a first `evalCode` (verified working; the host-`newFunction`-assertion approach is broken because `context.throw()` from a host function does not propagate into the guest caller — a failing `expect` was recorded as passed):

```js
globalThis.__tests = [];
globalThis.test = (name, fn) => { try { fn(); __tests.push({name, passed: true}) } catch (e) { __tests.push({name, passed: false, error: e?.name + ": " + e?.message}) } };
globalThis.expectEqual = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("expected " + JSON.stringify(b) + ", got " + JSON.stringify(a)) };
globalThis.expectTrue  = (v, msg = "expected truthy") => { if (!v) throw new Error(msg) };
globalThis.expectCloseTo = (a, b, eps = 1e-6) => { if (Math.abs(a - b) > eps) throw new Error(`expected ~${b}, got ${a}`) };
globalThis.assert = (cond, msg = "assertion failed") => { if (!cond) throw new Error(msg) };
// auto-run: host calls test() fns after guest eval, or guest calls run() at the end
```

After the guest's own `evalCode` (which registers tests via `test(...)` — registration executes the fn immediately or the harness's `run()` call runs them; pick **register-then-run** so test bodies can't hijack eval), read `getProp(context.global, "__tests")` → `dump` → array of `{name, passed, error?}`. Verified end-to-end: failing assertion and throwing test both land as `{passed: false, error}`.

### Result serialization

Cross the boundary with `dump()` only — plain JSON-able values (no handles, functions, or class instances survive; `Error` → `{name, message, stack}`). The completion value of the guest script (last expression) is `result`; guard `dump(result.error) === null` (built-in failure without exception, observed on a 20 M-char regex replace) → synthesize `"internal sandbox failure"`. Optionally `JSON.stringify` inside the guest for full control, but host-side `dump` was sufficient and simpler.

### Env limits (matching CONTEXT + corrections)

| Env | Default | Notes |
|---|---|---|
| `SANDBOX_TIMEOUT_MS` | 1000 | wall-clock in handler; roadmapped guardrail |
| `SANDBOX_MEMORY_LIMIT_MB` | 64 | `setMemoryLimit`; best-effort per PITFALLS #6 (strings under-accounting, issue #271, open at 0.32.0 — not re-reproduced here; keep source-size caps) |
| `SANDBOX_STACK_KB` | 64 | **hard-cap 128 at the code level** — >256 KB reproduces the dispose-abort poison |

## Gotchas (phase-specific)

1. **Singlefile variant is dead on workerd** — `CompileError: Wasm code generation disallowed by embedder` at `newQuickJSWASMModuleFromVariant(singlefileVariant)`. All wrangler bundling resolves fine (pure ESM, no node builtins — verified by grep); it dies at instantiation. The fallback in CONTEXT.md fires for real; adopt `wasmfile` + `newVariant({wasmModule})` (see Summary). The CONTEXT "Bundle math: +3.1MB" estimate is also stale: measured **+0.6 MiB raw / +254 KiB gzip**.
2. **`setMaxStackSize(1 MiB)` (CONTEXT locked default) bricks the context at dispose** — native WASM stack overflows first; `dispose()` then aborts (`list_empty(&rt->gc_obj_list)`). Use 64 KB (cap 128 KB). This is the single most dangerous silent misconfiguration in the locked plan.
3. **Wrap `dispose()` in its own try/catch, separate from eval** — the abort path throws *from dispose* even when `evalCode` "just" threw a host RangeError. A single try/finally that lets the dispose exception mask the real cause will misreport crashes.
4. **`dump(errorHandle)` can be `null`** (built-in failure without JS exception). Never `String(e.name)` unguarded when mapping `error` vs `timeout` — check `e?.name === "InternalError" && String(e?.message).includes("interrupted")` defensively, else `timeout` detection breaks and crashes get misreported as `error`.
5. **Handle leaks** — every `newFunction`/`newObject`/`setProp`-sourced handle, every `evalCode` result handle (`value` *and* `error`), and every arg handle in console callbacks needs `dispose()`. Release builds don't detect leaks; `vm.dispose()` throwing `RuntimeError` on leaks is the (bad) detector. Keep the FFI call surface tiny (console fns, globals, two evals, one getProp) so discipline is auditable by eye.
6. **Built-in overshoot is bounded but real** — interrupt polls exist inside string built-ins now (vendored quickjs 2025-09-13), but escaping a multi-second built-in took 7.2 s after budget exhaustion. A 20 M-char regex replace runs 11–12 s and can end in a null-error handle. Keep `MAX_GUEST_SOURCE_BYTES` (~20 KB per PITFALLS #5) and small spec inputs; do not promise sub-deadline precision for pathological built-ins.
7. **Promise shadowing does not forbid async** — QuickJS async functions bypass the global. Enforce sync-only guests with a post-transpile source gate rejecting `async `/`await `/`new Promise`/`setTimeout`/`fetch(` (PITFALLS #7 list) — verified necessary by spike row 12.
8. **`context.throw()` from host functions does not propagate to the guest caller** (it throws "when execution resumes"); any host-function-based assertion mechanism will silently pass failures. Guest-side harness source is the fix (verified).
9. **Abort poisoning is containable, not fatal** — the module singleton kept serving after a dispose-abort (same isolate), the abort is a catchable host exception, and a fresh module instance costs ~3 ms. Policy: fresh context per exec (CONTEXT decision — verified correct: `module.newContext()` = fresh runtime owned by the context, one dispose), catch dispose aborts, count them, rebuild the singleton after 3.
10. **Guest clocks tick** — guest `Date.now()` advanced ~5.7 s across a multi-second busy loop (host `Date.now` import). So guests *can* observe time; that's harmless for us, but don't build "guest can't know the time" assumptions into specs. Per-step timings stay host-side `performance.now()` around `evalCode` (all spike ms values came from there and were sane).
11. **`loadMs` memoization subtlety** — `modulePromise ??=` means the *second* request reports the first's timing; report the memoized `loadMs` for the healthz identity flip, and note module init is ~5 ms (instantiate-only; compile happened in the bundler), so lazy init on first execution is cheap enough to keep (Phase 2 pattern).
12. **`wrangler.jsonc` rules: don't add a Wasm rule** — `CompiledWasm` for `**/*.wasm` is already a default (adding it logs a "does not have a fallback" warning); `"type": "Wasm"` fails config parsing outright. The real requirement is the **project-local copy** of the `.wasm` because rules don't apply under `node_modules/`.

## Sources

| Source | What it grounds | Confidence |
|---|---|---|
| /tmp/qjs-spike live run in real workerd (wrangler 4.149.0, workerd 1.20261006.1, 2026-10-12; 20 cases: bundling, module init, timing, calibration, whileTrue ±catch, built-in polling ×2, memory ×2, stack ×4 sizes, jobs, promise shadow, console capture, completion, guest harness ×2, abort-recovery, clock freeze, handler wall-clock) | every **[SPIKE]** claim above, including all matrix rows | High (directly measured on the pinned runtime) |
| Packed tarballs: quickjs-emscripten-core@0.32.0, @jitl/quickjs-singlefile-browser-release-sync@0.32.0, @jitl/quickjs-wasmfile-release-sync@0.32.0, @jitl/quickjs-ffi-types@0.32.0 (`.d.ts` + minified module + FFI glue inspected) | all API signatures, exports maps, embed mechanics, newVariant/newContext implementations, singlefile purity | High (primary artifacts, version-pinned) |
| npm registry (npm view, 2026-10-12) | versions, dist-tags, package existence (wasmfile-browser does not exist) | High |
| quickjs-emscripten README/docs (via index.d.mts variant table) | vendored quickjs version 2025-09-13+f1139494, sync vs asyncify tradeoffs | High (official) |
| justjake/quickjs-emscripten issues #60, #269, #271, #219, #211 (via PITFALLS.md, 2026-10-10) | dispose-abort class, memory accounting gap, historical built-in opacity | Medium-High (#219 empirically *softened* by this spike; #271 not re-reproduced) |
| CONTEXT.md locked decisions | baseline being verified | superseded in 3 places: variant choice, stack size, deadline mechanism (all corrected above) |
