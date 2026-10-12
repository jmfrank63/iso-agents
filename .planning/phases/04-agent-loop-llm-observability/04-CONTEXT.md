# Phase 4 Context: Agent loop + LLM + observability

**Phase:** 04 — Agent loop + LLM + observability
**Captured:** 2026-10-11 (auto mode — all decisions are recommended defaults, logged for audit)

## Decisions

### LLM provider contract
[auto] Q: "What does an LLM turn return?" → Selected: **`complete(messages) → Promise<{text, usage?}>` provider seam (raw fetch under an OpenAICompatibleLlmProvider; no SDK dependency); agent layer extracts `{explanation, files: Record<filename, content>}` from the text with robust parsing: strip markdown fences → JSON.parse → on failure retry once with a "respond with ONLY valid JSON" corrective message → LLM_MALFORMED iteration status if still bad** (recommended default).

### Prompt strategy
[auto] Q: "How is the conversation structured?" → Selected: **system prompt (senior-TS role, hard rules: return ONLY the JSON contract, all code must type-check under strict es2022, tests must pass) + task/spec as first user message + one feedback message per failed iteration, windowed to the last 3 iterations** (recommended default). Feedback message contains: exact type diagnostics (formatted `file:line:col TSxxxx: message`) OR failed test names + assertion errors + captured logs, plus "fix and return the FULL file(s) again".

### Mock provider realism (the demo heart)
[auto] Q: "How does the keyless mock demo a REAL fix loop?" → Selected: **deterministic stateful scenario keyed by a hash of (task, spec): iteration 1 returns code with a planted type error AND a planted failing assertion; iteration 2 fixes the type error only (sandbox then fails); iteration 3 returns the correct implementation** (recommended default). So a mock run proves the full gate sequence: typecheck-fail → sandbox-fail → success. Mock also honors a `MOCK_FAIL_AFTER` env (or `scenario: "hopeless"` request field? NO — keep request shape minimal: mock converges in 3 unless env override caps iterations lower, in which case terminal status is max_iterations).

### Loop policy
[auto] Q: "Iteration rules?" → Selected: **typecheck gate before sandbox (CORE-03); success (typecheck ok AND all sandbox tests pass) exits early; hard cap AGENT_MAX_ITERATIONS (default 5); run deadline AGENT_RUN_DEADLINE_MS (default 25000) checked before each LLM call; terminal statuses: success | max_iterations | run_deadline | llm_error | llm_malformed** (recommended default).

### Transcript & timings
[auto] Q: "What does a run record look like?" → Selected: **`{id, status, iterations: [{n, llmMs, explanation, files, typecheck: {ok, diagnostics, ms} | null, sandbox: {status, tests, logs, ms} | null, feedback}], timings: {llmMs, typecheckMs, sandboxMs, totalMs}, createdAt, finishedAt}`** stored in the in-memory registry (Phase 1 runs.ts seam), returned by POST /agent/run and GET /agent/run/:id (OBS-01/02) (recommended default).

### /agent/run semantics
[auto] Q: "Sync or async?" → Selected: **synchronous JSON response** (recommended default) — the mock loop completes in seconds; async/job polling is out of scope. Request: `{task: string, spec: {functionName: string, description: string, tests: Array<{name, expr}>}}` — hmm, keep tests AS CODE: `spec: {entry: string, code: string}` where code includes test calls using the injected harness? DECIDED: request `{task, spec}` where spec is a plain-language description + the agent writes `test()` calls itself per system prompt; response validates via the sandbox harness. **Simplify: `{task: string, spec: string, maxIterations?: number}`** — the mock provider keys scenarios off (task, spec) and ships two built-in scenarios (slugify-style string function; fibonacci-style math function); unknown tasks get the generic converging scenario.

### /typecheck stats (TYPE-03)
[auto] Q: "Benchmark endpoint shape?" → Selected: **POST /typecheck `{files: Record<name,content>, runs?: number}` → `{ok:true, data:{runs: number, results: [{run, ms}], minMs, medianMs, meanMs, coldMs}}`** (recommended default) — the tsc-rs benchmark hook.

### tsc-rs story
[auto] Q: "How is the tsc-rs context told?" → Selected: **README "Why" section + timings in every response + Typechecker interface documented as the drop-in seam (tsc-rs = native binaries today, no WASM; when a WASM build lands, implement Typechecker against it)** (recommended default).

## Notes for downstream agents

- Compose over existing seams ONLY: LlmProvider (new), Typechecker (Phase 2), SandboxRuntime (Phase 3), run registry (Phase 1), timing fields (already flowing). No new architectural surfaces.
- The agent loop is a pure orchestrator module (`src/agent/loop.ts`) — LLM, typechecker, sandbox injected; unit-testable with stubs WITHOUT the worker graph (vitest small-module discipline; end-to-end via test:live harness).
- Mock provider is default when LLM_PROVIDER unset or "mock"; "openai" reads LLM_BASE_URL/LLM_API_KEY/LLM_MODEL and does one retry on 5xx/timeout with llm_error status surfaced if exhausted.
- healthz: `agent: getAgentIdentity()` ("mock-provider ready" / "openai-compatible") — new key appended LAST so Phase 1 payload keys stay ordered/stable.
- The live harness grows: mock-loop success path (3 iterations, gates in order), max_iterations path (env-capped), GET /agent/run/:id roundtrip, 404 unknown run, /typecheck stats sanity (runs=3, median sane, coldMs ≥ minMs), malformed-JSON retry path? (only if mock scenario includes it — NOT in v1 mock; skip).
