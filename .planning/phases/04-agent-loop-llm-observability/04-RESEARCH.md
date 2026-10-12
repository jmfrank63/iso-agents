# Phase 4 Research: Agent loop + LLM + observability

**Phase:** 04 | **Researched:** 2026-10-12
**Inputs:** 04-CONTEXT.md (locked decisions), ROADMAP Phase 4 SC, REQUIREMENTS CORE/LLM/TYPE/OBS, STATE.md bindings, src/index.ts + src/runs.ts + src/typecheck/* + src/sandbox/* + scripts/test-*-live.mjs, research/STACK.md (LLM decision).

## Summary

Phase 4 composes four existing seams (registry, Typechecker, SandboxRuntime, timings) behind a new `LlmProvider` seam with zero new dependencies. Everything API-risky was verified locally rather than trusted: a scratch workerd probe (wrangler 4.149.0 / workerd 1.20261006.1) confirmed `AbortSignal.timeout()`, `AbortSignal.any()`, and `setTimeout` exist and work in request context, and that `fetch` reaches host-loopback services — a black-holed localhost fetch aborted with DOM `TimeoutError` at exactly the requested 1500 ms. A typescript@6.0.3 probe confirmed `transpileModule` reports **syntactic diagnostics only** (a planted TS2322 yields zero diags; syntax errors yield `Error`-category TS1005) and that `export` keywords **survive** transpilation under `module: ESNext` — so guests must be script-style, enforced by prompt rule + optional source gate. Recommended layout: `src/agent/{provider,mock,extractor,loop}.ts` + `src/typecheck/transpile.ts`, per-request provider construction (kills mock state races), registry grown to the CONTEXT terminal-status set with a 50-run insertion-order cap, and one new `scripts/test-agent-live.mjs` harness (two sequential wrangler boots: normal + capped/black-hole env), keeping the proven duplicated-harness pattern. Three planning-level gotchas need pinning: the `deadline` vs `run_deadline` status-name conflict, the breaking `/typecheck` response-shape change for the Phase 2 harness, and `MOCK_FAIL_AFTER`'s ambiguous semantics.

## Verified API Facts

### OpenAI-compatible chat-completions (raw fetch) — confidence HIGH (docs knowledge; de-facto standard shape)

- **Request**: `POST ${LLM_BASE_URL}/chat/completions` with headers `content-type: application/json` and `authorization: Bearer ${LLM_API_KEY}` (omit the auth header when key is empty — many local compat servers need none). Body: `{model: string, messages: Array<{role: "system"|"user"|"assistant", content: string}>, temperature?: number}`. `stream` omitted = false. No other fields needed.
- **Response 200**: `{id, object: "chat.completion", created, model, choices: [{index, message: {role: "assistant", content: string | null}, finish_reason}], usage?: {prompt_tokens, completion_tokens, total_tokens}}`. Read `choices[0].message.content`; treat `null` content or empty `choices` as a malformed/failed call.
- **Errors**: any non-200 → surface as `llm_error`. Compat servers' error bodies vary (`{error:{message,type,code}}` on OpenAI) — do **not** parse them; include `status` + first ~500 chars of body text in the error detail for the transcript.
- Shape confidence HIGH (stable across OpenAI/vLLM/Ollama/LocalAI); any single server's error-body shape is not relied on.

### `fetch` + `AbortSignal.timeout` under workerd — confidence HIGH (verified in real workerd, scratch probe)

Probe: `/tmp/p4probe`, `wrangler dev` on workerd 1.20261006.1 (wrangler 4.149.0), real HTTP against a black-hole TCP server. Results:

| Claim | Result |
|---|---|
| `typeof AbortSignal.timeout` in workerd | `"function"` ✅ |
| `typeof AbortSignal.any` in workerd | `"function"` ✅ |
| `typeof setTimeout` + timer fires in request context | `"function"`; 100 ms wait measured 101 ms ✅ |
| `fetch("http://127.0.0.1:<port>")` from inside workerd via `wrangler dev` | connects to host-loopback services ✅ (local dev subrequests originate from the wrangler process) |
| `fetch(..., {signal: AbortSignal.timeout(1500)})` vs a never-responding server | throws `TimeoutError: The operation was aborted due to timeout` at wall 1501 ms ✅ |

Caveat (flagged honestly): the probe ran config-less (default compat flags), not the repo's `no_nodejs_compat` pair — but `AbortSignal`/`setTimeout` are web-standard globals, unaffected by node-compat flags (repo phases 1–3 already rely on sibling web APIs). The recommended live-harness llm_error case closes this in the real config. Docs (Web standards page, 2026-04-23) confirm the AbortController/AbortSignal family and timers; they name the family, not the `timeout()` static — hence the probe.

### `ts.transpileModule` on typescript@6.0.3 — confidence HIGH (verified against the installed package)

Probe (`node -e` against repo node_modules, `reportDiagnostics: true`):

- **Semantic diags: NONE.** A TS2322-planted source produced **0 diagnostics** — transpileModule never type-checks. The loop's typecheck→transpile ordering is mandatory, not stylistic.
- **Syntactic diags: YES.** `function f( {` → 3 `Error`-category TS1005 diagnostics. Good enough as a pre-sandbox syntax tripwire (post-typecheck-gate these should be impossible).
- **`export` survives** under `{target: ES2022, module: ESNext}` → output keeps `export function…`, which is a SyntaxError in QuickJS strict global eval. Under `module: None` output degrades to CommonJS (`exports.__esModule`) — equally broken in-sandbox. **Guests must be import/export-free scripts.**

Recommended call shape (mirrors `GUEST_COMPILER_OPTIONS` + the Phase 2 transpile-only impl):

```ts
const r = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true },
  fileName: "guest.ts",
  reportDiagnostics: true,
});
// r.outputText: string; r.diagnostics?: readonly ts.Diagnostic[] (map with the existing mapDiagnostic)
```

`removeComments` stays default (false → keep comments; harmless). Guests don't import, so `module` is inert; ESNext is chosen purely for symmetry with `GUEST_COMPILER_OPTIONS`.

### Composition with Phase 2's checker

Same `ts` instance is automatic (one bundle, one module graph). `mapDiagnostic()` in src/typecheck/index.ts:52 is module-private — export it (or move it) so `src/typecheck/transpile.ts` can reuse it and the transcript's transpile diagnostics have the identical `{code,message,line,column,file,category}` shape as typecheck diagnostics. The loop passes LLM files as a `Map` with rooted names (`/guest.ts`) straight into `getTypechecker().check()` — exactly the `/typecheck` route convention.

### workerd facts already established by Phases 1–3 (reused, no re-research)

- `performance.now()` advances inside sync guest execution and is the loop's clock for deadlines/timings; `Date.now()` freezes in global scope (lazy-memoize pattern in src/index.ts:21).
- Local `wrangler dev` does not enforce Cloudflare CPU limits (STACK, MEDIUM confidence) — the 25 s run deadline is **our own** wall-clock check, not the runtime's.
- vitest cannot pull the typecheck/sandbox module graphs (8.8 MB WS 1009 crash) — small-module discipline holds: `loop.ts` must `import type` the `Typechecker`/`SandboxRuntime`/`LlmProvider` interfaces so loop/extractor/mock logic specs stay vitest-safe with stubs.
- Sandbox contract the loop must respect: sync-only source (`findAsyncUsage` gate), max 20480 bytes, fresh single-use context per execute, `ExecuteResult = {status: ok|error|timeout|crash, logs, tests, result?, error?, ms}`, `__tests` recorded even when the guest throws mid-run (skipped on timeout).

## Recommended Implementation

### Module layout

```
src/agent/
  provider.ts    LlmProvider seam + OpenAiCompatibleLlmProvider + createLlmProvider(env) + getAgentIdentity(env)
  mock.ts        MockLlmProvider + scenario table (pure data, no graph imports → vitest-safe)
  extractor.ts   stripFences + extractContract(text) → {explanation, files} (pure → vitest-safe)
  loop.ts        runAgentLoop(task, spec, deps) — pure orchestrator; import type only for seams
src/typecheck/
  transpile.ts   transpileGuest(source) → {js, diagnostics, ms}; reuses exported mapDiagnostic
src/runs.ts      grown in place (statuses, record shape, 50-run cap)
src/index.ts     POST /agent/run handler; /typecheck gains N-run stats; healthz `agent` key appended LAST
scripts/test-agent-live.mjs   new live harness (see below)
package.json     test:live chain += `node scripts/test-agent-live.mjs`
```

### Signatures

```ts
// provider.ts
export interface LlmMessage { role: "system" | "user" | "assistant"; content: string }
export interface LlmUsage { promptTokens: number; completionTokens: number; totalTokens: number }
export interface LlmCompletion { text: string; usage?: LlmUsage }
export class LlmError extends Error { constructor(msg: string, readonly retryable: boolean, readonly detail?: unknown) }
export interface LlmProvider { readonly id: string; complete(messages: LlmMessage[]): Promise<LlmCompletion> }
export interface LlmProviderEnv { LLM_PROVIDER?: string; LLM_BASE_URL?: string; LLM_API_KEY?: string; LLM_MODEL?: string }
export function createLlmProvider(env: LlmProviderEnv, timeoutMs: number): LlmProvider
// "mock" (default / unset) → MockLlmProvider; "openai" → OpenAiCompatibleLlmProvider;
// "openai" without LLM_BASE_URL or LLM_MODEL → throw at request time → surfaces as llm_error (honest).
export function getAgentIdentity(env: LlmProviderEnv): string // "mock-provider ready" | "openai-compatible"

// OpenAiCompatibleLlmProvider.complete() internals (~40 lines, STACK decision):
//   fetch(`${baseUrl}/chat/completions`, { method:"POST",
//     headers: { "content-type":"application/json", ...(apiKey && { authorization:`Bearer ${apiKey}` }) },
//     body: JSON.stringify({ model, messages, temperature: 0.2 }),
//     signal: AbortSignal.timeout(timeoutMs) })
//   non-200 → LlmError(retryable: status>=500 || 429, detail: `${status} ${body.slice(0,500)}`)
//   AbortSignal/network (TimeoutError/TypeError) → LlmError(retryable: true)
//   !choices?.length || content==null → LlmError(retryable: false)
//   ONE retry when retryable (CONTEXT: "one retry on 5xx/timeout"); exhausted → LlmError(retryable:false)

// extractor.ts
export interface LlmContract { explanation: string; files: Record<string, string> }
export class MalformedContractError extends Error {}
export function extractContract(text: string): LlmContract
// order: strip ``` fences (```json … ``` / ``` … ```) → JSON.parse → fail: retry parse on text.slice(first "{", last "}"+1)
// → validate files is a non-empty Record<string,string> + explanation string (default ""). Mock always emits clean
// JSON (DECIDED); fence-stripping + salvage exist for real providers. Cross-check vs ROADMAP SC1 wording in Gotcha G4.

// transpile.ts
export function transpileGuest(source: string): { js: string; diagnostics: TypecheckDiagnostic[]; ms: number }
```

```ts
// loop.ts
export interface AgentLoopDeps {
  provider: LlmProvider; typechecker: Typechecker; sandbox: SandboxRuntime;
  maxIterations: number;   // request maxIterations ?? AGENT_MAX_ITERATIONS ?? 5 (clamp 1..10, min MOCK_FAIL_AFTER)
  deadlineMs: number;      // AGENT_RUN_DEADLINE_MS ?? 25000
}
export interface AgentIteration {
  n: number; llmMs: number; explanation: string; files: Record<string, string>;
  typecheck: TypecheckResult | null;   // null when extraction failed
  transpileMs: number | null;          // OBS-01 (CONTEXT's iteration shape omitted it — add it; see G5)
  sandbox: ExecuteResult | null;       // null when typecheck gate failed (CORE-03)
  feedback: string | null;             // exact text of the next feedback message
}
export interface AgentRunResult {
  status: "success" | "max_iterations" | "run_deadline" | "llm_error" | "llm_malformed";
  iterations: AgentIteration[];
  timings: { llmMs: number; typecheckMs: number; transpileMs: number; sandboxMs: number; totalMs: number };
}
export async function runAgentLoop(task: string, spec: string, deps: AgentLoopDeps): Promise<AgentRunResult>
```

Loop body (per iteration): deadline check → LLM (t=`performance.now()`) → extract → write files (Map, rooted `/guest.ts`) → typecheck gate (fail ⇒ feedback = formatted diagnostics, continue) → transpile (record ms; Error-category diags ⇒ feedback, continue — near-impossible post-gate) → `sandbox.execute(js)` ⇒ success iff `status==="ok" && tests.length>0 && every(passed)` (tests.length===0 ⇒ feedback "no test() calls found; add tests per spec" — guards a test-less LLM answer) ⇒ else feedback = failed test names + errors + captured logs + "fix and return the FULL file(s) again". Feedback formatting per CONTEXT: `file:line:col TSxxxx: message` lines from `mapDiagnostic` output, or test results + `logs`.

### Deterministic mock (the demo heart)

Per-run instance (recommended): `handleAgentRun` calls `createLlmProvider(env, timeoutMs)` **per request** (same pattern as `getSandboxRuntime(env)`), so `MockLlmProvider`'s call counter is naturally per-run — no shared-state races, and "stateful" (CONTEXT) means stateful across a run's iterations. Scenario **selection** keys off `(task, spec)` text: lowercase substring sniff — `slug` → slugify scenario, `fib` → fibonacci scenario, anything else → generic fallback **which is the fibonacci scenario's code** (CONTEXT: "unknown tasks get the generic converging scenario"). The mock always emits its own scenario code regardless of the requested function name — the typecheck/sandbox gates still operate genuinely on it; document this in the mock's header. Mock output is always clean JSON (DECIDED), identical contract shape to a real LLM: `{"explanation": "...", "files": {"guest.ts": "<full file>"}}`.

Built-in scenarios, exact planted code (single file `guest.ts`, no import/export, no async — sandbox-legal; all regexes QuickJS-safe):

**(a) slugify scenario** — iteration 1 plants TS2322 **and** carries a latent logic bug (invisible: the gate skips the sandbox):

```ts
function slugify(input: string): string {
  const slug: number = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug;
}
test("lowercases and hyphenates", () => { expect(slugify("Hello World")).toEqual("hello-world"); });
test("trims and collapses separators", () => { expect(slugify("  A -- B  ")).toEqual("a-b"); });
```

Iteration 2 fixes only the type (`const slug: number` → `const slug: string`) but drops trim/edge-strip — `slugify("  A -- B  ")` returns `"-a-b-"`: test 1 passes, test 2 fails (`expected "a-b", got "-a-b-"`). Iteration 3 is correct: `input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")` — both pass. Gate sequence proven: typecheck-fail → sandbox-fail → success, exactly CONTEXT's locked design.

**(b) fibonacci scenario** (= generic fallback) — iteration 1 plants TS2322:

```ts
function fibonacci(n: number): number {
  if (n <= 1) return n;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i++) {
    const next: string = String(a + b);
    a = b;
    b = next;
  }
  return b;
}
test("fib(0) and fib(1)", () => { expect(fibonacci(0)).toEqual(0); expect(fibonacci(1)).toEqual(1); });
test("fib(7) is 13", () => { expect(fibonacci(7)).toEqual(13); });
```

Iteration 2 fixes the type (`const next: string = String(...)` → `const next = a + b;`) but plants an off-by-one (`i < n` instead of `i <= n`): returns fib(n−1), so `fib(7)` yields 8 — `expected 13, got 8`; the fib(0)/fib(1) test still passes (partial-pass feedback demo). Iteration 3 corrects to `i <= n` → 13. Both scenarios keep `next`/`slug` type-legal in iterations 2–3 under `strict`.

### Run deadline & message windowing

- `deadline = performance.now() + deadlineMs` at loop start; **checked before each LLM call** (CONTEXT policy); expiry ⇒ terminal `run_deadline`. Per-LLM-call fetch timeout = `max(1000, min(deadlineMs - 2000, 30000))` — no new env var; a hung provider can overshoot the deadline by at most one call + retry, bounded by `AbortSignal.timeout`.
- Exact message array (CONTEXT windowing: system + task/spec first user message + last 3 feedback messages):

```ts
const messages: LlmMessage[] = [
  { role: "system", content: SYSTEM_PROMPT },
  { role: "user",   content: `${task}\n\nSPEC:\n${spec}\n\nReturn ONLY the JSON contract.` },
  ...feedback.slice(-3),  // one user-role message per failed iteration, oldest → newest
];
```

No assistant-role echoes (CONTEXT names only feedback messages; keeps the window tiny and the mock trivial). `SYSTEM_PROMPT` hard rules (CONTEXT + sandbox contract): senior-TS role; return ONLY the JSON contract `{"explanation","files"}`; code must type-check under strict ES2022; tests must pass; **single script-style file, no imports/exports, no async/Promise** (sandbox gates); write `test("name", () => { expect(...) })` calls per spec; return FULL files every time.
- Usage accounting optional: attach `usage` to the iteration transcript when the provider returns it (openai); mock omits it.

### Registry changes (src/runs.ts — Phase 1 seam, grown in place)

```ts
export type RunStatus = "running" | "success" | "max_iterations" | "run_deadline" | "llm_error" | "llm_malformed";
// CONTEXT locked set: renames Phase 1's "deadline" → "run_deadline" and adds "llm_malformed" (see G1)

export interface RunRecord {
  id: string; status: RunStatus; task: string;
  createdAt: string; finishedAt: string | null;
  iterations: AgentIteration[];                       // structural import from loop.ts (type-only)
  timings: AgentRunResult["timings"] | null;
}
const MAX_STORED_RUNS = 50;
runRegistry.create(task): RunRecord        // evicts oldest entry when size would exceed 50 (Map insertion-order delete)
runRegistry.get(id): RunRecord | undefined // unchanged contract; 404 path untouched
runRegistry.finalize(id, status, iterations, timings): void  // sets status + finishedAt
```

Transcripts include full file contents per iteration (~a few hundred KB worst case) → 50 runs ≈ low MB, safely inside the 128 MB isolate. Eviction is FIFO by insertion, not true LRU — fine for a prototype (true LRU = delete+set in `get`, only if the planner wants it). `GET /agent/run/:id` for a `running` record is unobservable over HTTP (the loop is synchronous), so the existing 404 semantics and Phase 1 harness assertions are unaffected.

### Routes wiring (src/index.ts)

- `POST /agent/run` → `handleAgentRun(request, env)`: validate `{task: non-empty string, spec: non-empty string, maxIterations?: number 1..10}` → 400 `bad_request` otherwise → `create` registry record → `runAgentLoop` → `finalize` → 200 with the full record (CORE-05). An unexpected throw still yields the Phase 1 500 envelope; the record stays `running` (acceptable prototype honesty, note in code).
- `POST /typecheck` → stats shape per CONTEXT: `{files, runs?: number}` → `{ok: true, data: {runs, results: [{run, ms, ok}], minMs, medianMs, meanMs, coldMs}}`; default `runs` 5, clamp 1..100; `coldMs = results[0].ms`; median = classic even/odd. **`results[].ok` is an addition to CONTEXT's shape** so the Phase 2 harness keeps a red/green assert (see G2). Median/mean computed on unsorted-by-ms `results` (run order preserved).
- `GET /healthz` → append `agent: getAgentIdentity(env)` **last** (CONTEXT: keep Phase 1 key order stable).
- `Env` interface: add `AGENT_RUN_DEADLINE_MS?: string` and `MOCK_FAIL_AFTER?: string` (AGENT_MAX_ITERATIONS + LLM_* already exist).

### Live harness (scripts/test-agent-live.mjs)

Keep the **duplicated** harness pattern (DECIDED — simpler for prototype): each `test-*-live.mjs` is a self-contained, proven boot/poll/assert/teardown unit; extracting `scripts/lib/dev-server.mjs` buys DRY at the cost of churning two load-bearing verification scripts. Revisit only if a 4th harness appears. New file copies the existing spawn/detached/healthz-poll/process-group-kill skeleton and adds:

- **Boot A (no env overrides):**
  1. healthz `agent === "mock-provider ready"`, and it is the LAST key in `runtime`.
  2. Slugify fixture `POST /agent/run` → 200, `status==="success"`, exactly 3 iterations; iter1: `typecheck.ok===false`, `sandbox===null` (the CORE-03 gate), `diagnostics[0].code===2322` (**this re-homes the TS2322-over-HTTP exactness coverage lost from the Phase 2 harness** — assert file/line sanity too); iter2: `typecheck.ok===true`, `sandbox.status==="ok"`, exactly one test failed with `expected "a-b"` in its error; iter3: all tests passed; every timing > 0 and `timings.totalMs >=` sum of parts; `transpileMs` present.
  3. `GET /agent/run/:id` roundtrip equals the POST response (transcript + timings + status).
  4. Fibonacci fixture → success/3 iterations; unknown task (`"mystery"`) → converges and `iterations[2].files["guest.ts"]` contains `function fibonacci` (generic fallback proof).
  5. Validation: missing `spec` → 400; malformed JSON → 400; 404 unknown run id (cheap re-assert).
  6. `POST /typecheck {files:{guest.ts:GREEN}, runs:3}` → `runs===3`, 3 results, `minMs <= medianMs <= maxMs` sane, `coldMs === results[0].ms`, all `ok===true`; red snippet → `results[0].ok===false`.
- **Boot B (spawn env `AGENT_MAX_ITERATIONS=2`, `LLM_PROVIDER=openai`, `LLM_BASE_URL=http://127.0.0.1:<blackhole>`, `LLM_API_KEY=x`, `LLM_MODEL=test`):** in-process black-hole server (`createServer(s => s.on("data", () => {}))`, swallow bytes, never respond — the probe pattern). Cases: mock run capped → `status==="max_iterations"` after 2 iterations; openai run against the black hole → `status==="llm_error"` after the retry (proves fetch + `AbortSignal.timeout` + error handling **under the repo's real `no_nodejs_compat` config**, closing the probe caveat); healthz `agent` flips to the openai-compatible identity.

## Gotchas

1. **Status-name conflict (planning must pin).** ROADMAP SC2 / CORE-04 say `deadline`; CONTEXT (locked, later) says `run_deadline` + adds `llm_malformed`; src/runs.ts today has `deadline` and no `llm_malformed`. Recommendation: CONTEXT wins (`run_deadline`, `llm_malformed`) and runs.ts is the single source; note the rename where CORE-04 is validated.
2. **`/typecheck` response shape is a breaking change for the Phase 2 harness.** `scripts/test-typecheck-live.mjs` asserts `data.ok`, `data.diagnostics[].code/line/column/file`, `data.ms` — all gone in the CONTEXT stats shape. Plan an explicit migration of cases 1–4/8–9 (assert `results[0].ok` + stats sanity). The exact TS2322@1:7 coverage **cannot** move to vitest (8.8 MB module crash) — it re-homes into test-agent-live.mjs via the mock scenario's iteration-1 diagnostic (Gotcha: only if the slugify scenario above is kept verbatim).
3. **`export` survives transpilation** (verified) → `SyntaxError` in QuickJS strict global eval. Enforce by system-prompt rule + optional regex source gate mirroring `findAsyncUsage` (cheap, gives the LLM a clear fix message instead of a cryptic eval error); the feedback loop heals it either way. `transpileModule` never reports semantic diags (verified) — the typecheck gate must run first.
4. **ROADMAP SC1 vs CONTEXT mock wording.** SC1 says the mock's "broken first response [has] markdown fences"; CONTEXT's live-harness note says the malformed-JSON retry path is "NOT in v1 mock; skip". Research decision (per task): mock emits clean JSON always; fences/stripping stay an extractor affordance for real providers; SC1's demonstrable (`iterations >= 2`) is preserved at 3 iterations. Flag the parenthetical as pre-CONTEXT wording.
5. **OBS-01 needs transpile ms; CONTEXT's iteration shape omits it.** Add `transpileMs` per iteration + `timings.transpileMs` aggregate (sum). Tiny, but it's a CONTEXT-shape delta the planner should log.
6. **`MOCK_FAIL_AFTER` semantics are ambiguous in CONTEXT** ("env override caps iterations lower"). Recommended: it caps the loop's `maxIterations` for mock runs (`min(maxIterations, MOCK_FAIL_AFTER)`) → terminal `max_iterations`; alternative: mock stops converging after N calls (requires `AGENT_MAX_ITERATIONS` to stay ≥ N). Boot B of the harness depends on which one is chosen.
7. **`AbortSignal.timeout` throws `TimeoutError`** (a DOMException, name `"TimeoutError"`) — classify by `err.name`, not `instanceof`; network refusal surfaces as `TypeError: fetch failed`. Both are retryable; non-5xx HTTP errors are not.
8. **Registry eviction is FIFO** (Map insertion order); `get()` does not refresh recency. Concurrent `/agent/run` requests share the isolate Map — prototype-acceptable, but a finalizing a record mid-flight is impossible (single-owner per request) so no torn writes.
9. **JSON-in-JSON escaping** — guest code contains newlines inside the contract's `files` strings; the mock uses `JSON.stringify` so it's automatic; real LLMs occasionally emit raw newlines in string literals → `JSON.parse` fails → corrective-retry path exists by design (CONTEXT). Keep the corrective message exact ("respond with ONLY valid JSON").
10. **Local dev does not enforce Cloudflare CPU/stack limits** (MEDIUM confidence, STACK) — the 25 s run deadline is self-enforced wall-clock; don't let any planning artifact assume the runtime will kill an overrunning loop.

## Sources

| Source | Confidence | Notes |
|---|---|---|
| Live workerd probe (scratch, `/tmp/p4probe`): wrangler 4.149.0 / workerd 1.20261006.1, black-hole TCP server | HIGH | `AbortSignal.timeout`/`AbortSignal.any`/`setTimeout` all `"function"`; timer fires in request context (101 ms); `fetch` to `127.0.0.1` connects; black-holed fetch aborted with `TimeoutError` at wall 1501 ms for a 1500 ms signal |
| Local probe on installed typescript@6.0.3 (`node -e` against repo node_modules) | HIGH | `transpileModule` + `reportDiagnostics`: TS2322-planted source → 0 diagnostics; syntax-broken source → 3 Error TS1005; `export` preserved under `module: ESNext`; CommonJS degradation under `module: None` |
| Cloudflare Workers docs — Web standards (2026-04-23), Fetch (2026-07-05) | HIGH | AbortController/AbortSignal family, timers, fetch in request context; standard built-ins per Chrome stable minus eval/new Function/WASM-codegen; `performance.now()`/`Date.now()` semantics (superseded in detail by Phase 3's in-guest measurement) |
| OpenAI chat-completions API shape (docs knowledge; de-facto compat standard) | HIGH (shapes) / MEDIUM (any single compat server's error body) | Request/response/usage shapes above; error bodies surfaced as text, never parsed |
| Repo: src/{index,runs}.ts, src/typecheck/{index,host,vfs}.ts, src/sandbox/{runtime,harness,limits}.ts, scripts/test-{typecheck,sandbox}-live.mjs | HIGH | Seams composed: `Typechecker.check(Map)`, `SandboxRuntime.execute(js)` + `ExecuteResult`, registry 404 path, harness boot/teardown pattern, `findAsyncUsage` gate to mirror, `mapDiagnostic` to export |
| .planning: 04-CONTEXT (locked), ROADMAP, REQUIREMENTS (CORE/LLM/TYPE-03/OBS), STATE.md bindings, research/STACK.md | HIGH | Status set, windowing, mock design, sync-response semantics, vitest discipline, raw-fetch LLM decision |
