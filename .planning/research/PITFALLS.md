# Domain Pitfalls
**Domain:** in-isolate coding agent runtime (workerd + tsc-js + quickjs-wasm + LLM loop) | **Researched:** 2026-10-10

---

## Critical Pitfalls

### Pitfall 1: `npm i typescript` no longer installs the pure-JS compiler (TS 7 is native-only)
**What goes wrong:** As of Oct 2026, `npm install typescript` resolves to TypeScript **7.0.2** (verified: `dist-tags.latest = 7.0.2`), which ships native platform binaries (`@typescript/typescript-linux-arm64`, 26MB) and **no `lib/lib.*.d.ts` files**. There is no WASM build.
**Why it happens:** The TS 7 line (tsgo/tsc-rs era) replaced the npm package's default with the native compiler; the wiki carries a banner that the compiler API described applies to "TypeScript 6.0 and earlier."
**Consequences:** In workerd you cannot spawn native child processes — the in-isolate type-check plan silently dies at integration time. Even the "parse a string" path fails because lib declarations are absent.
**Prevention:** Pin `typescript@~5.9.3` explicitly in package.json (measured: 8.7MB `typescript.js` + 3.3MB of `lib.*.d.ts`). Document why the pin exists so nobody "upgrades" it. Keep the `Typechecker` interface seam (already planned) so tsc-rs can slot in later.
**Detection:** `node -e "console.log(require('typescript/package.json').version)"` at CI/boot; a boot-time assertion that `ts.createProgram` exists and `lib.es5.d.ts` contents are resolvable from the VFS.

### Pitfall 2: Missing default lib files — `getDefaultLibFileName` is a *name*, not a path, and there is no filesystem behind it
**What goes wrong:** With target `ES2020`, the compiler asks the host for `lib.es2020.full.d.ts` → transitively `lib.es5.d.ts`, `lib.dom.d.ts`, etc. A naive in-memory host returns `undefined` from `getSourceFile`/`readFile` for these, and every program fails with TS2318/TS2688 ("Cannot find lib definition") plus cascading "Cannot find name 'Promise'/'console'/'Math'" errors.
**Why it happens:** `getDefaultLibFileName(options)` returns a bare filename like `lib.esnext.full.d.ts` — the host is responsible for resolving it to contents (confirmed confusion in microsoft/TypeScript#35318). `ts.sys` / `ts.createCompilerHost()` assume a real filesystem, which doesn't exist in a workerd isolate.
**Consequences:** Type-check is useless: every run reports hundreds of phantom errors, the agent loop "fixes" non-bugs, iterations never go green.
**Prevention:** Inline the lib `.d.ts` contents at build time (esbuild text loader / `?raw` imports) into a module-level `Map<string, string>`; implement a custom `CompilerHost` where `getSourceFile` reads only from the VFS + this lib map; `getDefaultLibFileName` returns the key you put in the map. Restrict to the minimal set: `lib.es5.d.ts` (216KB) + `lib.es2015.d.ts` (+~1.9MB if you include `lib.dom`); skip `lib.dom.d.ts` (1.8MB) and `.full` variants (pull DOM/WebWorker) unless tasks need them. Configure `lib` in `CompilerOptions` explicitly rather than relying on `target` defaults.
**Detection:** `POST /typecheck` on a trivial `const x: number = "a"` — if you see "Cannot find lib definition" or "Cannot find name 'console'", the lib mapping is broken.

### Pitfall 3: Bundling `typescript` into a Worker trips over Node built-ins and the default host
**What goes wrong:** `typescript.js` references `fs`, `path`, `os`, `perf_hooks` (inside `ts.sys`/`getNodeSystem`). esbuild/wrangler either fails resolution, or — with `nodejs_compat` (default at compatibility date ≥ 2026-08-04) — resolves them to workerd natives/unenv polyfills where calling anything throws `[unenv] ... is not implemented` or reads a filesystem that doesn't exist. Accidentally calling `ts.createCompilerHost()` or `ts.sys.*` at runtime then explodes or returns garbage.
**Why it happens:** The package detects its environment lazily; workerd looks Node-like enough under `nodejs_compat` to take the wrong branch.
**Consequences:** Build-time bundler errors, or runtime crashes deep inside tsc on first type-check.
**Prevention:** Only use pure APIs (`createProgram`, `createSourceFile`, `transpileModule`, `flattenDiagnosticMessageText`); never touch `ts.sys`, `ts.createCompilerHost`, `ts.getDefaultLibFilePath` (it queries the real fs). Provide a **complete** host: `getSourceFile`, `fileExists`, `readFile` (return `undefined` for unknown paths — that's the correct "not found" signal), `directoryExists` → false, `readDirectory` → [], `getCurrentDirectory` → "/", `getCanonicalFileName` → identity, `getNewLine` → "\n", `useCaseSensitiveFileNames` → true, `writeFile` → discard or write to VFS. Keep `noEmit: true` for checks. Verify `wrangler deploy --outdir --dry-run` bundle size stays sane (~12MB total expected, well under the 64MiB limit).
**Detection:** Bundle-size line in `wrangler dev` startup output; a boot-time `/healthz` self-test that type-checks one known-good snippet through the custom host.

### Pitfall 4: QuickJS guest stack overflow or heavy allocation aborts the entire WASM module — uncatchable, and dispose-after-the-fact aborts again
**What goes wrong:** Guest code with deep recursion (`RangeError: Maximum call stack size exceeded` at the WASM layer) or ~100k+ object allocations inside a promise job leaves the runtime un-freeable: a later `context.dispose()`/`vm.dispose()` throws `Aborted(Assertion failed: list_empty(&rt->gc_obj_list) ... JS_FreeRuntime)` (issues justjake/quickjs-emscripten#60, #269). `abort()` in WASM is not a catchable JS error.
**Why it happens:** QuickJS internal invariants are violated by stack exhaustion / GC-during-job; Emscripten abort tears down the whole module instance.
**Consequences:** The request dies with an opaque 500; if you cached one QuickJS module/context at module scope, **every subsequent request** on that isolate fails too — the prototype looks randomly bricked.
**Prevention:** `runtime.setMaxStackSize(...)` (e.g. 320KB–1MB) so guest recursion throws a catchable QuickJS error before native overflow; create a **fresh context (or runtime) per sandbox execution** and dispose it in a `finally`; never reuse a context that errored; keep the module-level `QuickJSWASMModule` (that's safe to reuse) but treat contexts as single-use. Constrain generated code style in the prompt (no deep recursion).
**Detection:** Any log containing `Aborted(` or `RuntimeError: unreachable` — treat the sandbox instance as poisoned and rebuild it (or accept isolate re-creation) rather than retrying on the same context.

### Pitfall 5: Infinite guest loops — the interrupt handler is the only defense, and it has gaps
**What goes wrong:** `evalCode` is fully synchronous and blocks the workerd request until it returns. Without an interrupt handler, a generated `while(true){}` hangs the request forever (no wall-clock timeout in local dev). Even with `setInterruptHandler`/`shouldInterruptAfterDeadline`, the handler is only polled at loop back-edges/function entries — a single long built-in operation (e.g. `new Array(1e9) + ''`) never yields to it and can run for tens of seconds (issue #219), and interruption of long async-inside-promise runs is unreliable (#211).
**Why it happens:** workerd gives the isolate the CPU; QuickJS is a cooperative interpreter; built-in algorithmics don't poll.
**Consequences:** Hung requests, unreadable curl sessions, and in production the CPU-limit kill (error 1102) instead of a clean error.
**Prevention:** Always pass `shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + N)` (e.g. 1000–2000ms per execution) or `runtime.setInterruptHandler` with a deadline; set `memoryLimitBytes`/`runtime.setMemoryLimit` as a secondary backstop; cap generated source size (e.g. 20KB) and iteration count (e.g. 5) so total worst-case wall time is bounded; keep guest strictly synchronous (see Pitfall 7) so there are no promise jobs to leak time through. Accept the documented residual risk on pathological built-ins (prototype-scale inputs make them improbable).
**Detection:** Integration test with a literal `while(true){}` guest must return a structured timeout error within deadline + ε; alert if any single request exceeds ~2× the sum of your budgets.

### Pitfall 6: Memory accounting — 128MB isolate limit is shared JS+WASM, and `setMemoryLimit` under-enforces
**What goes wrong:** `runtime.setMemoryLimit(N)` only refuses a *single* allocation larger than N for strings/typed arrays — the running total doesn't advance for them, so a guest can reach gigabytes under a small limit (issue #271, reproduced **on workerd** via vitest-pool-workers). Simultaneously, tsc program churn (each `createProgram` parses lib `.d.ts` + builds ASTs) accumulates on the JS side. When the isolate crosses 128MB, workerd lets in-flight requests finish and creates a **fresh isolate** — your module-scope run store is silently wiped.
**Why it happens:** QuickJS malloc-limit accounting gap (#271, open at 0.32.0); JS heap and WASM heap both count against the per-isolate 128MB (Cloudflare limits doc).
**Consequences:** `GET /agent/run/:id` starts returning 404 mid-session; OOM manifests as error 1102 in production.
**Prevention:** Treat `setMemoryLimit` as best-effort only: enforce your own budgets (source ≤ 20KB, spec/assertions ≤ 50KB, iterations ≤ 5); fresh context per execution; memoize parsed lib SourceFiles across iterations (see Pitfall 9) and drop each iteration's program; optionally sample `runtime.computeMemoryUsage()` and rebuild the context past a threshold.
**Detection:** Sudden loss of in-memory state between requests without a file change = isolate eviction; log `computeMemoryUsage().memory_used_size` per run in dev.

### Pitfall 7: Guest async / asyncify — keep the sandbox synchronous or suffer reentrancy crashes
**What goes wrong:** Tempting to run the transpiled guest with `async`/`await` support via the ASYNC variants. Asyncify builds are 2× larger (1MB vs 492KB wasm measured) and slower; only **one** suspension can be in flight — a reentrant host call that suspends again crashes the module; guest code awaiting anything needs you to manually pump `runtime.executePendingJobs()` after every settlement or you deadlock; and interruption of long promise chains is unreliable (#211).
**Why it happens:** QuickJS's C API is synchronous; asyncify rewrites the whole WASM module with single-suspension semantics.
**Consequences:** Deadlocked or aborted requests; timing numbers polluted.
**Prevention:** Use the **sync release variant** (`@jitl/quickjs-wasmfile-release-sync`); generate guests as plain functions returning values (or a `results` array); forbid `await`/`setTimeout`/`fetch` in guest code (spec + lint of the source before transpile); provide no async APIs in the guest globals — only `console`, `JSON`, `Math`, assertion hooks.
**Detection:** A grep/lint step rejecting guest sources containing `await `, `=> new Promise`, `setTimeout`, `importScripts`, `fetch(`.

### Pitfall 8: workerd forbids host dynamic eval — don't design around it, sandbox for real
**What goes wrong:** The natural shortcut "transpile then `eval`/`new Function` the output in the host isolate" is impossible: workerd blocks `eval()`/`new Function(string)` (the only escape hatch, `allow_eval_during_startup`, covers *startup* only — request-time code-gen throws). `node:vm` is a non-functional stub module.
**Why it happens:** Workers security model (code injection / Spectre mitigations).
**Consequences:** Any architecture that assumes host eval fails at first execution; also means QuickJS-WASM is not optional, it's the only path.
**Prevention:** Route all generated-code execution through QuickJS; cross the boundary with JSON-serializable data only (`vm.dump` produces plain JS values — no handles, no functions, no class instances). Import nothing from the guest side; expose only whitelisted host functions (assertion recorder) via `vm.newFunction`.
**Detection:** Any `eval`/`new Function`/`require('node:vm')` in the codebase = design bug; grep in CI.

### Pitfall 9: Recreating `createProgram` from scratch every iteration — latency and memory churn kill the loop
**What goes wrong:** A fresh `ts.createProgram` per agent iteration re-parses the lib declarations (2–3MB of `.d.ts`) and rebuilds all ASTs; combined with QuickJS's WASM heap this burns hundreds of ms per check and piles garbage onto a 128MB budget. Developers also reach for `createWatchProgram`/`LanguageService` machinery that assumes `ts.sys` and timers.
**Why it happens:** The compiler API defaults to a cold program; nothing tells you the builder API exists.
**Consequences:** Type-check dominates loop time (the exact thing the tsc-rs narrative says must not happen); memory pressure → isolate eviction (Pitfall 6).
**Prevention:** Keep a module-level cache of lib `SourceFile`s (memoize `getSourceFile` for lib names — they never change). Use `ts.createSemanticDiagnosticsBuilderProgram` + pass `oldProgram` back into the next `createProgram` call so unchanged files (the libs!) are reused (documented "BuilderProgram" strategy in the TS wiki). Type-check only the single generated file, with `noEmit: true`. Use `transpileModule` (not program emit) for the JS output — it's a string→string transform and deliberately skips type-checking you already did.
**Detection:** The `/typecheck` endpoint's timing (a project requirement) — compare first vs repeated checks; if repeated checks aren't meaningfully faster and stable, caching isn't working.

---

## Moderate Pitfalls

### Pitfall 10: LLM output isn't clean code — markdown fences, prose, and non-JSON payloads
**What goes wrong:** Real providers wrap code in ```` ```ts ```` fences (sometimes ```` ```typescript ````, sometimes with a filename line), prepend explanations, or return malformed JSON when asked for structured output.
**Why it happens:** Chat-completion models are conversational by default.
**Consequences:** Type-check of fence markers → syntax error at line 1; loop wastes iterations "fixing" the fence.
**Prevention:** Robust extraction: try strict JSON parse → fallback to regex for fenced block (```` ```(?:ts|typescript)?\n([\s\S]*?)``` ````) → fallback to first/last heuristic; strip shebang-like annotation lines; feed extraction failures back as a normal iteration error so the mock and real provider exercise the same path. Have the mock provider emit a fenced first iteration deliberately.
**Detection:** Unit tests over a fixture set of ugly LLM responses.

### Pitfall 11: Prompt bloat and infinite fix loops across iterations
**What goes wrong:** Each iteration appends diagnostics + prior code to the prompt; context grows quadratically, and the agent cycles on the same error forever (or oscillates).
**Why it happens:** Naive "add to history" loop design; no exit criteria.
**Consequences:** Token cost, CPU cost, unbounded request duration.
**Prevention:** Window the history (keep spec + current code + last diagnostics only); hard `maxIterations` (5 is plenty for prototype tasks); early-exit on zero diagnostics + all assertions pass; **stale-loop detection** — if the normalized diagnostic set (code+line+message hash) is identical two iterations in a row, break with a structured "not converging" result.
**Detection:** Loop telemetry per run: `iterations`, `lastErrorHashes` — any run hitting `maxIterations` in tests should be reviewed, not expected.

### Pitfall 12: Mock provider that's too perfect
**What goes wrong:** A mock that returns the correct program on iteration 1 never exercises diagnostics feedback, retry, or fence extraction — the loop's actual deliverable is untested.
**Why it happens:** Mock written to make demos green.
**Consequences:** False confidence; real provider integration surprises.
**Prevention:** Script the mock with at least two behaviors (broken-first-shot mode: reference error + fence wrapping; instant-green mode) selected by request flag; assertions in the demo task should require sandbox output, not just a clean type-check.
**Detection:** A test asserting `iterations >= 2` for the broken-first-shot scenario.

### Pitfall 13: WASM loading in workerd — you cannot fetch the `.wasm` at runtime
**What goes wrong:** Default quickjs-emscripten variants load the WASM file via `fs.readFile`/`new URL(...)` — both forbidden in Workers ("that's forbidden in Cloudflare workers", official example comment). Instantiation fails with a confusing loader error.
**Why it happens:** workerd has no filesystem and restricts dynamic loads.
**Consequences:** Sandbox never initializes.
**Prevention:** Copy the variant pattern from `examples/cloudflare-workers/src/index.mts`: `import wasmModule from './quickjs.wasm'` (esbuild/wrangler turns it into a `WebAssembly.Module` binding) and pass `newVariant(baseVariant, { wasmModule })` to `newQuickJSWASMModuleFromVariant`. Initialize lazily inside the first request (`QuickJS ??= await ...`) — don't do heavy top-level work.
**Detection:** Boot-time self-test on `/healthz` that evaluates `"1+1"` in a throwaway context.

### Pitfall 14: Startup time and bundle size
**What goes wrong:** Parsing the 8.7MB `typescript.js` plus inlined lib sources at global scope risks the 1s "Script startup exceeded CPU time limit" (prod, error 10021) and slows `wrangler dev` restarts; total bundle ~11–12MB (tsc-js 8.7 + libs 2–3 + quickjs wasm 0.5) is fine vs the 64MiB cap but is a fixed cost per isolate.
**Why it happens:** Heavy module-scope imports.
**Consequences:** Slow cold starts; in prod, deploy rejection.
**Prevention:** Lazy-init both tsc artifacts (first type-check) and QuickJS (first execution); keep lib inlining to the minimal set; check with `wrangler deploy --dry-run --outdir`.
**Detection:** `wrangler check startup` / observed `wrangler dev` reload latency.

### Pitfall 15: Global-scope state (run store) is best-effort, and `wrangler dev` resets it behind your back
**What goes wrong:** A module-level `Map` for runs works until workerd evicts the isolate (memory pressure, runtime update — production gives ~30s grace then terminates), or until wrangler dev hot-reloads on file save. `GET /agent/run/:id` then 404s for a run that "succeeded" moments ago.
**Why it happens:** Isolates are ephemeral; local dev restarts the worker on every save.
**Consequences:** Confusing test failures that look like logic bugs.
**Prevention:** Accept it (prototype scope) but make the API honest: 404 with a JSON body `{ error: "run not found (isolate may have restarted)" }`; log isolate restarts; never persist anything requiring durability in module scope.
**Detection:** `/healthz` includes an `instanceId` (random per isolate boot) so you can tell when you're talking to a fresh isolate.

### Pitfall 16: Diagnostics handling — nested message chains, duplicates, and useless lib noise
**What goes wrong:** `diagnostic.messageText` can be a linked chain (`DiagnosticMessageChain`); `getPreEmitDiagnostics` returns lib-file errors and repeats across categories; positions are offsets, not line/col.
**Why it happens:** Compiler API returns raw structures (wiki).
**Consequences:** Garbage feedback to the LLM → wasted iterations.
**Prevention:** Always `ts.flattenDiagnosticMessageText(d.messageText, "\n")`; use `ts.getLineAndCharacterOfPosition(d.file, d.start)` for line/col; filter/skip diagnostics whose `file` is a lib file (shouldn't exist if Pitfall 2 is fixed — if they do, fix the host, don't filter); dedupe by `code:start:message`; cap reported diagnostics (~10) and include the generated source line text in the feedback.
**Detection:** Snapshot-test the formatter: one known-bad snippet → exact expected message list.

### Pitfall 17: Testing with vitest-pool-workers
**What goes wrong:** Known integration issues: dynamic `import()` inside `export default { fetch }` handlers doesn't work under the pool; module resolution of SSR-ish packages needs `deps.optimizer`; coverage is Istanbul-only; global setup files run in Node, not workerd. WASM itself works under the pool (quickjs issue #271 was reproduced there), so the sandbox is testable — but the friction is real.
**Why it happens:** The pool runs tests inside real workerd with esbuild analysis.
**Consequences:** Hours lost to config archaeology for a prototype.
**Prevention:** Prefer plain integration tests: script `wrangler dev` + `curl` (with `--max-time`) against `/healthz`, `/agent/run`, `/typecheck` and assert JSON; if using vitest, keep unit tests (formatter, extractor, mock LLM) pure-Node and reserve pool-workers tests for one end-to-end smoke.
**Detection:** N/A — decide up front and record it.

### Pitfall 18: HTTP edge cases
**What goes wrong:** (a) Unhandled exception in `fetch` → workerd's dev error page (HTML, not JSON); (b) no JSON body limit enforced by default (Cloudflare's 100MB cap is far above sanity) → a huge body can OOM the isolate; (c) curl defaults have no useful timeout against a hung request (Pitfall 5); (d) CORS headers absent — fine for curl, breaks any future browser client.
**Why it happens:** Prototype-mode assumptions.
**Prevention:** Wrap the whole handler in try/catch returning `{ error }` with 500 JSON (include `instanceId`); reject bodies > ~1MB with 413; always `await request.json()` inside try (malformed JSON → 400); add `--max-time 30` to all documented curl commands; add permissive CORS headers only if a browser client becomes real.
**Detection:** curl tests for: malformed JSON body, oversized body, and a guest that throws — all must return structured JSON, never HTML.

### Pitfall 19: Time measurement fidelity in workerd
**What goes wrong:** workerd historically advances `Date.now()` only across I/O and clamps/fakes timers for determinism; CPU-only stretches (a whole type-check!) may not advance the clock, distorting the per-step timings this project exists to produce. Local dev also forces `TZ=UTC` (documented) — surprising but harmless.
**Why it happens:** Determinism + Spectre mitigation in the runtime.
**Consequences:** Type-check or sandbox steps reporting ~0ms, or suspiciously equal timings.
**Prevention:** Record both `Date.now()` deltas and `performance.now()` deltas per step; treat numbers as relative/comparative (mock vs iteration counts), not absolute; verify timing granularity with a busy-loop micro-test in `wrangler dev` early in the project. (Confidence: medium — behavior has shifted across runtime versions; verify on your pinned workerd.)
**Detection:** If `typecheckMs` is exactly 0 for a real check, the clock isn't advancing — switch measurement strategy.

---

## Minor Pitfalls

**Handle leaks in QuickJS API use** — every `newString`/`getProp`/`unwrapResult` returns a handle needing `.dispose()`; `vm.dispose()` throws `RuntimeError` (or aborts, see #269) on leaks. *Prevention:* use `Scope.withScope` or `Lifetime.consume` everywhere; develop against the `DEBUG_SYNC` variant where `assertNoMemoryAllocated()` finds leaks, ship the release variant.

**Console doesn't exist in the guest** — QuickJS provides no `console`; guest `console.log` throws ReferenceError. *Prevention:* shim `console.log/info/error` via `vm.newFunction` + `vm.dump` into a per-run buffer; cap captured output (e.g. 8KB) and return it in the run result.

**`getQuickJS()` is async; `getQuickJSSync()` only after first await** — calling the sync accessor before initialization throws. *Prevention:* one module-level `readyPromise`; every entry point `await`s it.

**Module resolution inside guest transpilation** — generated code with `import`/`require` will fail (no loader in QuickJS sync variant). *Prevention:* require self-contained single-file programs in the spec; lint-reject imports in guest sources; return a friendly diagnostic when the transpiled output contains module syntax.

**Subrequest/connection limits (6 simultaneous waiting-for-headers; 50/request free)** — irrelevant for the mock provider, bites only when the real provider is enabled under load. *Prevention:* one LLM fetch per iteration, sequential — never parallel per run.

**Port/login friction** — `wrangler dev` binds 8787 by default and can sit on a stale port after a crash; the first request after a big edit pays recompile latency, which pollutes timings. *Prevention:* `--port` pinning; warm-up request before measuring; document curl base URL.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|---|---|---|
| Scaffold (wrangler config) | Wrong `compatibility_date` / missing flags change runtime behavior silently; nodejs_compat default flips at 2026-08-04 | Pin an explicit modern date; note it in config comments; `/healthz` echoes it |
| Scaffold | Bundle-time failure on `typescript`'s Node imports | Custom in-memory host only; never import `ts.sys` paths; dry-run bundle check in CI |
| VFS + Typechecker | TS 7 native installed by accident; lib `.d.ts` unresolvable | Pin `typescript@~5.9.3`; inline libs; boot-time self-test (Pitfalls 1–2) |
| VFS + Typechecker | Per-iteration `createProgram` cold cost | Builder program + memoized lib SourceFiles (Pitfall 9); measure via `/typecheck` |
| Transpile + Sandbox | WASM can't be fetched at runtime in workerd | `import ... from './quickjs.wasm'` + `newVariant({ wasmModule })` (Pitfall 13) |
| Transpile + Sandbox | Guest hangs/aborts (no interrupt, stack overflow, dispose crash) | Deadline interrupt + max stack + single-use contexts + sync-only guests (Pitfalls 4–5, 7) |
| Agent loop | Fenced/markdown LLM output breaks parsing | Multi-tier extraction + deliberate messy-mock (Pitfalls 10, 12) |
| Agent loop | Non-convergence / runaway iterations | maxIterations, stale-diagnostic early exit, windowed prompt (Pitfall 11) |
| Endpoints + timings | 500s return HTML; timings ~0ms; state 404s after reload | JSON error envelope everywhere; `performance.now()` + `Date.now()` dual timing; `instanceId` in healthz (Pitfalls 15, 18, 19) |
| Testing/docs | vitest-pool-workers config rabbit hole | curl + `wrangler dev` integration script as the primary E2E (Pitfall 17) |

---

## Sources

| Source | What it grounds | Confidence |
|---|---|---|
| Cloudflare Workers Limits docs (developers.cloudflare.com/workers/platform/limits, fetched 2026-10-10) | 128MB/isolate incl. WASM; 64MiB bundle; 1s startup; 10ms free / 30s paid CPU; eviction-on-OOM semantics; 30s runtime-update grace; 6 connections; 256KB logs; 100MB free body limit | High (official, current) |
| Wrangler configuration docs → Limits (…/workers/wrangler/configuration, fetched 2026-10-10) | "Limits are only enforced when deployed … not in local development" — `wrangler dev` does not enforce CPU/memory | High (official quote) |
| Cloudflare Local Development docs (…/workers/local-development) | `wrangler dev` = real workerd via Miniflare; local bindings simulated; `TZ=UTC` | High (official) |
| Cloudflare Node.js compatibility docs (…/workers/runtime-apis/nodejs) | nodejs_compat default ≥ 2026-08-04; `node:vm` = non-functional stub; unenv `[unenv] … not implemented` polyfills; fs/os partial support | High (official) |
| Cloudflare compatibility flags (…/workers/configuration/compatibility-flags) | `allow_eval_during_startup` — request-time `eval`/`new Function` blocked by default | High (official) |
| quickjs-emscripten README (main, fetched 2026-10-10) | interrupt handler/`shouldInterruptAfterDeadline`; `setMaxStackSize`; `setMemoryLimit`; asyncify 2× size + single-suspension + reentrancy crash; `executePendingJobs` deadlock note; console shim example; Workers variant/wasmModule loading; DEBUG_SYNC leak detection; dispose-throw on leaked handles | High (official repo) |
| quickjs-emscripten `examples/cloudflare-workers/src/index.mts` | Exact Workers loading pattern: `import wasm from './x.wasm'` + `newVariant`; "loading wasm bytes from URL is forbidden in CF workers"; lazy `QuickJS ??=` init | High (official example) |
| justjake/quickjs-emscripten issue #60 | Dispose abort (`list_empty(&rt->gc_obj_list)`) after guest stack overflow | High (with repro) |
| justjake/quickjs-emscripten issue #269 | Dispose abort after ~100k+ object allocations inside promise jobs; affects both engines; open at 0.32.0 | High (with repro, open) |
| justjake/quickjs-emscripten issue #271 | `setMemoryLimit` bounds single allocations, not totals (strings/typed arrays accumulate past limit); **reproduced on workerd** via @cloudflare/vitest-pool-workers | High (with repro on our target runtime, open) |
| justjake/quickjs-emscripten issue #219 | Interrupt handler never runs during long built-in ops (`new Array(1e9) + ''`) | High (with repro, open) |
| justjake/quickjs-emscripten issue #211 | Interruption unreliable for long async work inside promises | Medium (title/repro scope, not fully re-verified) |
| justjake/quickjs-emscripten issue #112 | Asyncify stack-size limits (ASYNCIFY_STACK_SIZE) | Medium |
| TypeScript wiki "Using the Compiler API" (raw wiki, fetched 2026-10-10) | Custom CompilerHost shape (`getSourceFile`/`fileExists`/`readFile` undefined semantics); `getDefaultLibFileName`; BuilderProgram strategies (`createSemanticDiagnosticsBuilderProgram` + `oldProgram`); `transpileModule` = no type-check; diagnostic flattening; TS7 banner ("describes TS ≤ 6.0") | High (official wiki) |
| microsoft/TypeScript issue #35318 | `getDefaultLibFileName` returns a bare filename, not a path — host must map it | High (maintainer-acknowledged) |
| Cloudflare Vitest integration "Known issues" (…/workers/testing/vitest-integration/known-issues) | Dynamic `import()` in default-export handlers unsupported; deps.optimizer for module resolution; Istanbul-only coverage; global setup runs in Node | High (official) |
| First-hand measurement in this sandbox (2026-10-10, node v24.19.0, npm 11) | `typescript` dist-tags: latest = 7.0.2 (native `@typescript/typescript-linux-arm64`, 26MB, no lib .d.ts); `typescript@5.9.3`: typescript.js = 8.7MB, all lib .d.ts = 3.3MB, lib.es5+lib.dom+lib.es2015 = 2.1MB; quickjs wasm: release-sync 492KB, release-asyncify 1.0MB, debug-sync 1.2MB | High (directly measured) |
| workerd frozen-time behavior (Date advancing on I/O) | Timing fidelity warning (Pitfall 19) | Medium (prior knowledge; not re-verified against current runtime docs — verify locally) |
