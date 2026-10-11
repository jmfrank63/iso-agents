# Architecture Patterns

**Domain:** in-isolate coding agent runtime | **Researched:** 2026-10-10

---

## Recommended Architecture

Single Cloudflare Worker (workerd isolate via `wrangler dev`), one request-scoped agent loop, all state in isolate memory. The system decomposes into a thin HTTP layer, an orchestrator that owns the loop, and a set of pluggable seams (LLMProvider, Typechecker, SandboxRuntime) so each can be swapped (mock → real, `typescript` → tsc-rs) without touching the loop.

```
                          POST /agent/run
                                │
                                ▼
                    ┌──────────────────────┐
                    │   HTTP Router        │  (thin: parse, validate, respond)
                    │  /agent/run /healthz │
                    │  /agent/run/:id      │
                    │  /typecheck          │
                    └─────────┬────────────┘
                              │ task + spec
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Agent Orchestrator (the loop)                  │
│                                                                     │
│   ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌───────────┐      │
│   │ 1.LLM   │───▶│ 2.VFS    │───▶│ 3.Type-  │───▶│ 4.Trans-  │      │
│   │ call    │    │ write    │    │ check    │    │ pile      │      │
│   └─────────┘    └──────────┘    └────┬─────┘    └─────┬─────┘      │
│        ▲                 │            │ errors         │ js         │
│        │                 │            ▼                ▼            │
│        │                 │       [gate: if errors,   ┌───────────┐  │
│        │                 │        skip 4-5, go to 7] │ 5.Sandbox │  │
│        │                 │                           │ (QuickJS) │  │
│        │                 │                           └─────┬─────┘  │
│        │                 │                                 ▼        │
│        │                 │                           ┌───────────┐  │
│        │                 │                           │ 6.Assert  │  │
│        │                 │                           │  runner   │  │
│        │                 │                           └─────┬─────┘  │
│        │                 ▼                                 ▼        │
│        │        ┌─────────────────────────────────────────────┐    │
│        └────────│ 7.Feedback builder (diagnostics + test      │    │
│   feedback      │  results → next prompt) or DONE             │    │
│                 └─────────────────────────────────────────────┘    │
│                              │                                     │
│          every step writes:  ▼                                     │
│   ┌──────────────────────────────────┐   ┌───────────────────────┐  │
│   │ RunStore (in-memory Map<id,Run>) │   │ TimingCollector       │  │
│   │ transcript, per-iteration record │   │ (t0/t1 per step)      │  │
│   └──────────────────────────────────┘   └───────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

Injected seams (constructor/config):
  LLMProvider  ──▶ MockProvider (default) │ OpenAICompatProvider (env keys)
  Typechecker  ──▶ TsCompilerTypechecker  │ (future: TscRsTypechecker)
  Sandbox      ──▶ QuickJSRuntime (WASM)  │ host eval never used
```

### Component boundaries

| Component | Responsibility | Communicates With |
|---|---|---|
| **HTTP Router** | Map routes (`POST /agent/run`, `GET /healthz`, `GET /agent/run/:id`, `POST /typecheck`) to handlers; JSON parse/validate; shape responses; no business logic | Orchestrator, RunStore (for `:id` lookup), Typechecker (direct for `/typecheck`) |
| **Agent Orchestrator** | Own the iteration state machine: prompt build → LLM → VFS → typecheck → transpile → sandbox → assertions → feedback; enforce `maxIterations`; mark run status (`running/green/failed`); write each step to the transcript | LLMProvider, VFS, Typechecker, Transpiler, SandboxRuntime, AssertionRunner, FeedbackBuilder, RunStore, TimingCollector |
| **LLMProvider** (seam) | `complete(messages): Promise<LLMResult>` — returns structured `{ explanation, files[] }`. MockProvider: deterministic scripted sequence per task (iteration 1 emits known-buggy code, later emits fix) so the loop demos with zero keys; OpenAICompatProvider: `fetch()` to any OpenAI-style endpoint, activated via env vars | Orchestrator only |
| **VFS** | In-memory `Map<string, string>` of `path → source`; single source of truth for generated code; reset/merge per iteration; exposes snapshots for transcript | Orchestrator, Typechecker, Transpiler |
| **Typechecker** (seam) | `check(files): Diagnostic[]` (file, line, col, code, message, severity). Impl: `typescript` npm package with in-memory compiler host + preloaded lib `.d.ts`. Future tsc-rs impl swaps in behind the same interface | VFS, Orchestrator |
| **Transpiler** | TS→JS emit (`ts.transpileModule` or reuse the program's emit output); isolated from typechecking so diagnostics and emit can be timed/changed independently | VFS, SandboxRuntime |
| **SandboxRuntime** (seam) | Execute JS safely: fresh QuickJS context per iteration, inject `console` capture + test harness globals, enforce memory/stack/CPU limits, pump promises, return `{ logs, result, error }` | Transpiler (receives JS), AssertionRunner (shares context/globals) |
| **AssertionRunner** | Runs the spec's assertions against the sandbox result: inject a harness module into QuickJS that wraps exported functions, records pass/fail per assertion, host reads results back via `vm.dump` | SandboxRuntime, Orchestrator |
| **RunStore** | In-memory `Map<runId, RunRecord>`; append-only transcript of iterations (prompt, response, files, diagnostics, test results, timings); serves `GET /agent/run/:id`; tolerate eviction (returns 404 after isolate recycle) | HTTP Router, Orchestrator |
| **TimingCollector** | Wrap every step with `start/end` ms (`llm.ms`, `typecheck.ms`, `transpile.ms`, `sandbox.ms`, `assert.ms`); per-iteration + cumulative totals; carried inside RunRecord | All components (called by Orchestrator around each step) |

Dependency rule: nothing talks to `typescript` or `quickjs-emscripten` directly except the Typechecker and SandboxRuntime impls; everything else depends on the interfaces.

---

## Data Flow

**Narrative.** A run starts with `POST /agent/run { task, spec, maxIterations? }`. The orchestrator creates a `RunRecord` (id, status=running, empty transcript), then enters the loop. Each iteration: (1) build messages (system prompt with the JSON contract + task/spec + accumulated feedback), (2) call LLMProvider, (3) parse the JSON response, write `files` into the VFS, (4) type-check — if diagnostics exist, skip execution and feed them back (type errors are cheap to fix and running would waste CPU), (5) if clean, transpile TS→JS and execute in QuickJS with the spec's assertion harness injected, (6) collect diagnostics/assertion results/logs/timings into the iteration record, (7) if all green → status=green, return; else build a feedback block and loop, until `maxIterations` → status=failed. The response body and `GET /agent/run/:id` return the same transcript.

**One-iteration walkthrough (iteration *n*):**

```
1. Prompt (messages):
   system: "You are a code agent. Respond ONLY with JSON: {explanation, files:[{path,contents}]}"
   user:   task + spec assertions
   user:   FEEDBACK (iterations 2+): type diagnostics + failed assertions from iteration n-1

2. LLMProvider.complete() ──▶ e.g. 412ms ──▶ parsed:
   { "explanation": "slugify lowercases, trims, replaces runs of non-alnum with '-'",
     "files": [ { "path": "/src/slugify.ts", "contents": "export function slugify(s: string): string { ... }" } ] }

3. VFS.set("/src/slugify.ts", ...)           (~0ms)

4. Typechecker.check(files)                  (timed; the headline number)
   clean  → continue to 5
   errors → feedback = ["src/slugify.ts(3,10): error TS2345: Argument of type 'number'
             is not assignable to parameter of type 'string'."] → go to 7

5. Transpiler: TS ──▶ JS                     (timed)

6. Sandbox: fresh QuickJS context; inject console-capture + harness; eval module + harness;
   pump pending jobs; read back:
   { logs: ["3 tests"], results: [ {name:"basic", pass:true},
     {name:"collapses dashes", pass:false, expected:"foo-bar", actual:"foo--bar"} ] }   (timed)

7. FeedbackBuilder appends to iteration record; not green ──▶ iteration n+1 prompt gains:
   FAILED TYPE CHECK: (none)
   FAILED TESTS:
     - "collapses dashes": expected "foo-bar", got "foo--bar"
   ──▶ LLM call #2 (this is the fix loop; the mock provider scripts exactly this arc)
```

**LLM JSON contract.** Responses are parsed, not trusted: wrap `JSON.parse` in a guard; on malformed output, feed the parse error back as feedback (iteration is consumed, loop continues). Keep the contract minimal and stable so the mock provider and real providers satisfy it identically:

```jsonc
// request → provider; response ← provider
{ "explanation": "string",
  "files": [ { "path": "/src/<name>.ts", "contents": "full file text" } ] }
```

**Feedback loop shape.** Diagnostics and test results are serialized deterministically (sorted by file/line) so iterations are diffable in the transcript and the mock provider can match on them. Every record carries `{ iteration, prompt, response, files, diagnostics, testResults, timings{llm,typecheck,transpile,sandbox,assert} }`.

---

## Patterns to Follow

| Pattern | What | When | Example snippet |
|---|---|---|---|
| **In-memory TS compiler host** | Provide `ts` a Map-based filesystem: implement `readFile`/`fileExists`/`readDirectory`/`getScriptFileNames` from the VFS map and preload lib `.d.ts` as strings, then `ts.createProgram` (or a LanguageService) works with zero disk access. This is exactly the TS Playground / `@typescript/vfs` model: `createSystem(fsMap)` → `createVirtualCompilerHost(system, options, ts)` → `ts.createProgram({ rootNames, options, host })` | Every type-check of generated code in an isolate (no fs). `@typescript/vfs` exists precisely to avoid hand-rolling this; or hand-roll a ~40-line host if avoiding the dep | ```ts import ts from "typescript"; const fsMap = new Map([["/src/slugify.ts", src], ["/lib/lib.es5.d.ts", es5LibText /* bundled string */]]); const host = ts.createCompilerHost(options); host.readFile = (p) => fsMap.get(p) ?? undefined; host.fileExists = (p) => fsMap.has(p); const program = ts.createProgram({ rootNames: ["/src/slugify.ts"], options, host }); ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));``` |
| **Lib `.d.ts` bundled as strings** | The compiler needs `lib.es5.d.ts` etc.; workerd cannot read them from disk at runtime, so embed them (copy into `src/` and `import es5 from "./lib.es5.d.ts?raw"`-style with a bundler rule, or import a generated TS module of string constants) at build time | Provisioning the Typechecker; also the general answer for any file-shaped dependency | `const fsMap = new Map(LIB_FILES.map(([name, text]) => ["/lib/" + name, text]));` where `LIB_FILES` is generated at build from `node_modules/typescript/lib` |
| **Typechecker & LLMProvider feature seams** | Define narrow interfaces; select impl by env/config at boot; mock is the default so the whole loop runs keyless. This is the TS Playground's own layering: the *sandbox* owns the compiler env, the app above just calls functions | Anywhere an implementation is expected to be swapped (mock→OpenAI, `typescript`→tsc-rs WASM later) | ```ts interface Typechecker { check(files: Map<string,string>): Diagnostic[] } interface LLMProvider { complete(msgs: Message[]): Promise<LLMResult> } const checker: Typechecker = env.TSC_RS === "on" ? new TscRsChecker() : new TsCompilerChecker(LIB_FILES);``` |
| **QuickJS execution with deadline + limits** | `quickjs-emscripten` supports Cloudflare Workers explicitly. Always set: interrupt handler (CPU/deadline), memory limit, max stack size. `shouldInterruptAfterDeadline(Date.now() + n)` is the one-liner | Every sandbox eval, no exceptions | ```ts const rt = QuickJS.newRuntime(); rt.setMemoryLimit(64 * 1024 * 1024); rt.setMaxStackSize(1024 * 320); let ops = 0; rt.setInterruptHandler(() => ++ops > 5_000_000 || Date.now() > deadline); // counter survives workerd's frozen Date.now(); deadline check helps where clocks advance const vm = rt.newContext(); // ... vm.dispose(); rt.dispose();``` |
| **Counter-based interrupt under frozen clocks** | workerd freezes `Date.now()` during synchronous execution (anti-Spectre design), so a pure wall-clock deadline may not fire mid-guest-loop. An op-count interrupt handler fires regardless; compute the deadline before eval, and treat the count as the hard backstop | Any synchronous guest execution inside workerd | `rt.setInterruptHandler(() => ++interruptCycles > MAX_OPS);` (per quickjs-emscripten README's own example) |
| **Console/log capture via host functions** | Guest code has no host access by default ("no host functionality is exposed"); implement `console.log` as a `newFunction` that dumps args into a host array, returned alongside the result | Every sandbox run — logs are agent feedback | ```ts const logs: string[] = []; const log = vm.newFunction("log", (...args) => logs.push(args.map(a => vm.dump(a)).join(" "))); const consoleH = vm.newObject(); vm.setProp(consoleH, "log", log); vm.setProp(vm.global, "console", consoleH); consoleH.dispose(); log.dispose();``` |
| **Promise pumping (`executePendingJobs`)** | Guest promises don't advance on their own: after resolving a deferred promise (or awaiting a guest promise via `resolvePromise`), call `runtime.executePendingJobs()` to resume guest execution — or you deadlock | Guest harness uses async functions or top-level await | `promise.settled.then(vm.runtime.executePendingJobs);` / `const r = await vm.resolvePromise(handle);` |
| **Fresh context per iteration + dispose discipline** | New `newContext()` per sandbox run (clean globals, bounded leaks); dispose every handle (use `Scope`/`using`/`.consume()`); `vm.dispose()` throws if handles leaked. In tests, run the `DEBUG_SYNC` variant and `assertNoMemoryAllocated()` | Every iteration; CI | `Scope.withScope(s => { const vm = s.manage(QuickJS.newContext()); ... });` |
| **WASM imports for workers** | workerd can't fetch/compile WASM from bytes at runtime; copy the QuickJS `.wasm` into `src/`, `import wasmModule from "./quickjs.wasm"` (wrangler treats `.wasm` imports as WebAssembly modules), then `newVariant(base, { wasmModule })` and `newQuickJSWASMModuleFromVariant` | Packaging quickjs-emscripten under wrangler (documented, required) | `import wasm from "./quickjs-wasmfile-release-sync.wasm"; const QJS = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmModule: wasm }));` |
| **Structured iteration transcript** | One `RunRecord` per run; one record per iteration with prompt, raw response, files, diagnostics, test results, per-step timings — appended immediately so `GET /agent/run/:id` is always current even if a later step crashes | The whole loop; required for the "why fast type-checking matters" story | `const t = timer(); const diags = checker.check(files); step.ms = t(); iteration.diagnostics = diags; store.update(run.id, run);` |
| **Fail-fast gate between typecheck and sandbox** | If type diagnostics exist, skip transpile+sandbox and go straight to feedback: cheaper in CPU (sandbox time is real CPU), and error messages from the compiler are higher-signal than runtime failures | Orchestrator loop design | `if (diags.some(d => d.severity === "error")) { feedback = fmt(diags); continue; }` |

---

## Anti-Patterns to Avoid

| Name | What | Why bad | Instead |
|---|---|---|---|
| **Host eval / `new Function`** | Running generated code with the isolate's own JS engine (`eval`, `new Function`, dynamic `import` of runtime-built strings) | workerd forbids dynamic code evaluation — code must ship as bundled JS/WASM; the whole security posture depends on it (no dynamic code loading; only pre-compiled JS/WASM is accepted) | Transpile TS→JS yourself and execute inside QuickJS-WASM (`quickjs-emscripten` officially supports Cloudflare Workers) |
| **Assuming the loop fits CPU limits by luck** | Letting LLM→typecheck→sandbox chains run synchronously without measuring | CPU time is the binding constraint: 10 ms/request on free, 30 s default on paid (configurable to 5 min). Exceeding it kills the isolate mid-request (Error 1102). A full `typescript` program build can eat hundreds of ms of CPU alone | Per-step timings everywhere (that's the point of `/typecheck`); keep prototype iterations small; on paid plan raise `limits.cpu_ms` deliberately; keep `maxIterations` low (2–5) |
| **Unbounded guest execution (no interrupt)** | `evalCode` in QuickJS without interrupt handler / memory / stack limits | A generated `while(true)` wedges the isolate until the platform CPU-kill takes the whole request (and the run) down; memory-hungry guests can push the 128 MB isolate limit | Always: `setInterruptHandler` (counter-based — see frozen-clock note), `setMemoryLimit`, `setMaxStackSize`, plus a wall-clock deadline checked between steps |
| **Trusting `Date.now()` during guest execution** | Deadline logic that expects the clock to advance while guest code spins | workerd freezes `Date.now()` during synchronous execution (returns time of last I/O) as an anti-Spectre measure — a wall-clock-only deadline never fires mid-loop | Op-count interrupt as the hard backstop; wall-clock checks between steps (after I/O) as soft guidance *(inference from documented frozen-clock rule — medium confidence on the interaction)* |
| **Assuming filesystem / `ts.sys` access** | Letting the TypeScript compiler (or any dep) read `lib.*.d.ts` or config from disk; calling `fs` paths | workerd exposes **no filesystem API at all** ("No API means no access"); `ts.sys` is disk-backed and will throw or silently miss files | In-memory compiler host with lib files bundled as build-time strings (see Patterns); pass `readFile`/`fileExists` overrides |
| **Shipping `typescript`/QuickJS assets wrong** | Relying on default WASM loading (`fetch` of URL / `fs.readFile`), shipping all four quickjs variants (~9 MB), or not preloading lib `.d.ts` | Workers can't read files or compile WASM from bytes at runtime; worker bundle cap is 64 MiB with a 1 s startup budget — dead weight and broken loads | Copy the one needed `.wasm` into `src/`, import it directly, use `newVariant(..., { wasmModule })`; use `quickjs-emscripten-core` + a single variant package; generate a lib-files module at build time |
| **Global mutable state as the store of record** | Treating the module-global run store as durable | Isolates are evicted at any time (resource pressure, suspicious activity, limits) — in-memory state vanishes | Fine for prototype: keep the Map but return 404 + `reason: "isolate_recycled"` for unknown ids; document that production moves to Durable Objects (see Scalability) |
| **Leaking QuickJS handles** | Forgetting `.dispose()` on contexts/handles between iterations | WASM heap grows monotonically inside a long-lived isolate → 128 MB memory kill (Error 1102), worst: late, under load | `Scope`/`using`/`.consume()` sugar; fresh context per iteration; `DEBUG_SYNC` variant + `assertNoMemoryAllocated()` in tests |
| **Deadlocking guest promises** | Awaiting a guest promise without pumping jobs | Guest async code only resumes when the host calls `runtime.executePendingJobs()`; skipping it hangs the request until client disconnect | `promise.settled.then(vm.runtime.executePendingJobs)` after every resolve; or `await vm.resolvePromise(handle)` which wraps the pump |

---

## Scalability Considerations

| Concern | Prototype (now) | Production path |
|---|---|---|
| Run state | In-memory `Map` in the isolate; lost on eviction | Durable Object per run: owns run state + transcript, survives isolates, gives a sync/WS point for streaming progress |
| Long-running loops (many iterations, slow LLM) | Sync HTTP request, bounded by client patience + CPU budget | Cloudflare Queues / Workflows: enqueue run, consumer executes (15 min wall per consumer), status polled via DO |
| CPU budget | Default 30 s (paid) / 10 ms (free — dev only); measure with `/typecheck` | Raise `cpu_ms` up to 5 min for heavy typecheck; or split iterations across queued invocations |
| Memory (128 MB/isolate, shared by concurrent requests) | One active run at a time, fresh QuickJS contexts | Limit concurrent runs per isolate (semaphore); stream large transcripts; offload artifacts to R2 |
| LLM provider | Mock default; OpenAI-compatible via env | Add streaming, retries/backoff, per-provider rate budgets; subrequest limits (10k paid) are ample |
| Observability | `timings[]` in JSON response | Workers Analytics Engine / Logpush; keep the same step names as metric dimensions |
| Typechecker | `typescript` JS package (CPU-heavy) | tsc-rs WASM build behind the same `Typechecker` seam — the timings data quantifies the win |

---

## Sources

| Source | What it grounds | Confidence |
|---|---|---|
| Cloudflare Workers Limits docs (developers.cloudflare.com/workers/platform/limits/, updated 2026-10-08) | CPU 10 ms free / 30 s paid default / 5 min max; 128 MB isolate memory; 64 MiB bundle; 1 s startup; no HTTP wall-clock limit; queue consumer 15 min; Error 1102; eviction behavior | High (official, current) |
| Cloudflare Security Model + How Workers Works docs | V8 isolates; no filesystem API ("No API means no access"); `Date.now()` frozen during execution; no native code — only JS/WASM; isolate eviction ⇒ don't trust global state; anti-Spectre rationale | High (official) |
| quickjs-emscripten README (github.com/justjake/quickjs-emscripten) | `shouldInterruptAfterDeadline`, `memoryLimitBytes`, `setInterruptHandler` (counter example), `setMemoryLimit`, `setMaxStackSize`, console capture via `newFunction`, `executePendingJobs`/`resolvePromise`, dispose/Scope discipline, DEBUG_SYNC leak testing, Cloudflare Workers support | High (official, matches APIs used) |
| quickjs-emscripten Cloudflare Workers example README | Required WASM packaging: copy `.wasm` into `src/`, import directly, `newVariant(base, { wasmModule })`; workers "refuse to let us read these files and compile them from bytes" | High (official example) |
| `@typescript/vfs` README (microsoft/TypeScript-Website) | Map-based virtual TS filesystem: `createSystem(fsMap)` → `createVirtualCompilerHost` → `createProgram`; lib `.d.ts` must be provisioned from node_modules/CDN/bundle; LanguageService diagnostics API | High (official) |
| TypeScript Playground README (microsoft/TypeScript-Website) | Layering: playground (UI) above TypeScript *sandbox* (compiler env owner) — precedent for compiler-env-as-a-component behind functions | Medium-High (official but positioning-level detail) |
| workerd forbids host `eval`/`new Function` | Dynamic code evaluation disabled in Workers runtime | Medium-High (documented platform position: only pre-compiled JS/WASM accepted; consistent error observed across workerd deployments; not re-verified in a single fetched page) |
| Counter-based interrupt needed under frozen `Date.now()` in workerd | Wall-clock deadlines may not fire during synchronous guest execution | Medium (inference from official frozen-clock doc + quickjs counter-interrupt pattern; not benchmarked) |
| Component decomposition, JSON LLM contract, fail-fast gate, feedback formatting | Design judgment synthesized from the above patterns (Playground layering, vfs, quickjs harness) for this prototype's shape | Design recommendation (n/a) |
