# Requirements: iso-agents

**Defined:** 2026-10-10
**Core Value:** The full agent loop — generate → type-check in-isolate → execute in-sandbox → feed errors back → fix — demonstrably runs end-to-end inside workerd, observable via HTTP with per-step timings.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Runtime

- [ ] **RUN-01**: Worker starts locally under real workerd via `wrangler dev` with no Cloudflare account or API tokens
- [ ] **RUN-02**: `GET /healthz` returns 200 with runtime identity (workerd version, compatibility date, typechecker/sandbox identities)
- [ ] **RUN-03**: Project builds with TypeScript and bundles clean (no Node builtins in the worker bundle)

### Agent Core

- [ ] **CORE-01**: `POST /agent/run` accepts `{task, spec}` (task description + behavior spec with assertions) and runs the full loop to green or guardrail
- [ ] **CORE-02**: Loop iterates: LLM call → write file(s) to in-memory VFS → type-check → transpile → sandbox execution → assertion evaluation → structured failure feedback → next LLM call
- [ ] **CORE-03**: Type errors gate execution: a failing type-check skips the sandbox and feeds diagnostics straight back to the LLM
- [ ] **CORE-04**: Loop stops on success (all assertions pass), on max iterations, or on run deadline — with distinct terminal status (`success`, `max_iterations`, `deadline`, `llm_error`)
- [ ] **CORE-05**: Response returns a full transcript: per-iteration LLM output, written files, type diagnostics, sandbox stdout/result, assertion results, and failure-feedback text

### Type-Checking

- [ ] **TYPE-01**: Type-checking runs inside the worker isolate using a pure-JS TypeScript compiler version (pinned; never native TS 7), with a boot-time identity assert
- [ ] **TYPE-02**: Type-checker uses a fully in-memory compiler host with bundled lib `.d.ts` strings — zero host filesystem access, real diagnostics (code, message, line) returned
- [ ] **TYPE-03**: `POST /typecheck` type-checks a posted snippet N times in-isolate and returns per-run latency stats (min/median/mean ms) — the tsc-rs benchmark hook
- [ ] **TYPE-04**: Type-checker sits behind a `Typechecker` interface so a future tsc-rs WASM build is a drop-in swap

### Sandbox

- [ ] **SAND-01**: Generated JS executes inside a QuickJS-WASM sandbox within the same isolate — no host `eval`/`new Function` anywhere
- [ ] **SAND-02**: Sandbox enforces an execution deadline (interrupt counter, since `Date.now()` freezes during sync guest execution) and a memory limit
- [ ] **SAND-03**: Guest console output is captured and returned; guest code cannot reach host state, fetch, or the VFS
- [ ] **SAND-04**: Each execution uses a fresh single-use context (crashed guests cannot poison later runs)

### LLM Provider

- [ ] **LLM-01**: LLM access sits behind a `LlmProvider` interface; provider chosen from env, defaulting to the deterministic mock
- [ ] **LLM-02**: Mock provider is stateful and imperfect: first response intentionally contains a type error and/or failing behavior, later responses converge — so the fix loop demonstrably loops and recovers with zero API keys
- [ ] **LLM-03**: OpenAI-compatible chat-completions provider activates via env vars (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) without code changes

### Observability

- [ ] **OBS-01**: Every step records wall-clock duration (LLM ms, type-check ms, transpile ms, sandbox ms, total ms) included in the response and stored with the run
- [ ] **OBS-02**: `GET /agent/run/:id` returns a stored run (transcript + timings + status) from the in-memory run store; unknown id → 404

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Streaming & UI

- **STREAM-01**: SSE streaming of iteration events as they happen
- **UI-01**: Minimal HTML page to watch a run live

### Benchmarks

- **BENCH-01**: Side-by-side benchmark endpoint: in-isolate JS tsc vs host-side `tsc-rs` native binary on identical snippets

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Durable Objects / KV / Queues persistence | Prototype observes runs within a request; isolate memory suffices |
| Production deployment to Cloudflare | Local `wrangler dev` demonstrates the scenario; deploy adds account requirements |
| Auth / multi-tenancy | Prototype |
| Agent tools beyond code-fix loop (search, shell, packages) | The loop is code → check → run → fix only |
| tsc-rs inside the worker runtime | Native binaries only today (no WASM); documented seam instead |
| Guest async / multi-file bundling in sandbox | Sync single-file guests keep the sandbox small and provably safe |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| RUN-01 | Phase 1 — Worker scaffold + health endpoint | Done |
| RUN-02 | Phase 1 — Worker scaffold + health endpoint | Done |
| RUN-03 | Phase 1 — Worker scaffold + health endpoint | Done |
| CORE-01 | Phase 4 — Agent loop + LLM + observability | Done |
| CORE-02 | Phase 4 — Agent loop + LLM + observability | Done |
| CORE-03 | Phase 4 — Agent loop + LLM + observability | Done |
| CORE-04 | Phase 4 — Agent loop + LLM + observability | Done |
| CORE-05 | Phase 4 — Agent loop + LLM + observability | Done |
| TYPE-01 | Phase 2 — In-isolate type-check core | Done |
| TYPE-02 | Phase 2 — In-isolate type-check core | Done |
| TYPE-03 | Phase 4 — Agent loop + LLM + observability | Done |
| TYPE-04 | Phase 2 — In-isolate type-check core | Done |
| SAND-01 | Phase 3 — QuickJS-WASM sandbox executor | Done |
| SAND-02 | Phase 3 — QuickJS-WASM sandbox executor | Done |
| SAND-03 | Phase 3 — QuickJS-WASM sandbox executor | Done |
| SAND-04 | Phase 3 — QuickJS-WASM sandbox executor | Done |
| LLM-01 | Phase 4 — Agent loop + LLM + observability | Done |
| LLM-02 | Phase 4 — Agent loop + LLM + observability | Done |
| LLM-03 | Phase 4 — Agent loop + LLM + observability | Done |
| OBS-01 | Phase 4 — Agent loop + LLM + observability | Done |
| OBS-02 | Phase 4 — Agent loop + LLM + observability | Done |

**Coverage:**
- v1 requirements: 21
- Mapped to phases: 21
- Unmapped: 0 ✅

> Note: the initialized count said 19; corrected during roadmap creation — the original tally omitted OBS-01 and OBS-02 (3 RUN + 5 CORE + 4 TYPE + 4 SAND + 3 LLM + 2 OBS = 21).

---
*Requirements defined: 2026-10-10*
*Last updated: 2026-10-11 after roadmap creation — all 21 v1 requirements mapped to phases*
