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

## Milestone v2 Requirements (defined 2026-10-13, delivered Phase 5)

- [x] **TSCRS-01**: `npm run bench:tsc-rs` runs the native tsc-rs binary (JS API) on 5 guest snippets; table printed + committed to docs/benchmarks.md and README
- [x] **TSCRS-02**: README documents where-things-run (tsc-rs native host-side today; Typechecker interface = drop-in seam when WASM lands; in-isolate pure-JS tsc)
- [x] **SHELL-01**: `POST /agent/shell` executes ls/cat/write/rm/typecheck/run ops over a per-request VFS in one stateless HTTP call
- [x] **SHELL-02**: shell run/typecheck ops inherit sandbox guardrails + checker gate semantics; zero host eval; caps (32 commands, 1MB VFS)
- [x] **SHELL-03**: unit specs (14) + live harness leg (54 ok-lines) covering happy/error/timeout/halt/validation sessions

## Milestone v3 Requirements (defined 2026-10-13)

- [ ] **WASM-01**: The tsc-rs WASM module is vendored as a committed artifact (`src/typecheck-wasm/ts_rust.wasm`, built from upstream pingdotgg/ts-rust at pin 569df52) with build provenance and rebuild-from-source instructions in `docs/ts-rust-wasm.md` — unpublished on npm, so deliberately no repo build step (`npm install` needs no rustup)
- [ ] **WASM-02**: `TscRsWasmTypechecker` runs the vendored wasm checker inside the isolate (fresh `WebAssembly.Instance` per check) with ts-js-identical fixture parity: clean guest → 0 diagnostics, TS2322 guests → exact 1-based code/line/column/file (`/guest.ts` 1:7 / 2:9), config diagnostics → `(program)` -1/-1, sorted by file/line/column, ok iff no Error category
- [ ] **WASM-03**: `TSCHECKER=ts-js|tsc-rs-wasm` selects the implementation through the `Typechecker` factory at every check call site (default `ts-js`, unknown values throw honestly); `/healthz` identity reads `unloaded` before the first check and the selected checker's id (`ts-rust@569df52 (wasm)` in wasm mode) after
- [ ] **WASM-04**: `npm run bench:tsc-rs` gains a third "wasm (in-isolate)" leg (a second `--var TSCHECKER:tsc-rs-wasm` boot, same 1-cold+5-warm protocol) with numbers from a real run committed to docs/benchmarks.md + README, and the README premise is corrected to "unpublished; built from source at pin 569df52" pointing at `docs/ts-rust-wasm.md`
- [ ] **WASM-05**: Coverage in BOTH TSCHECKER modes: small-module unit specs never drag the wasm/typescript graphs into the vitest transport; the wasm-mode live harness is the 5th `test:live` leg; the full gate chain (check / vitest / no-host-eval / bundle:check shipping both .wasm artifacts / bench 3 legs / 5 live harnesses) is green in both modes

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Durable Objects / KV / Queues persistence | Prototype observes runs within a request; isolate memory suffices |
| Production deployment to Cloudflare | Local `wrangler dev` demonstrates the scenario; deploy adds account requirements |
| Auth / multi-tenancy | Prototype |
| Agent tools beyond code-fix loop (search, shell, packages) | The loop is code → check → run → fix only |
| tsc-rs inside the worker runtime | Corrected 2026-10-13 — no longer out of scope: the wasm build is unpublished; built from source at pin 569df52 — shipped in-isolate (Phase 6, WASM-01..05) |
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
| WASM-01 | Phase 6 — tsc-rs WASM in-isolate | Planned |
| WASM-02 | Phase 6 — tsc-rs WASM in-isolate | Planned |
| WASM-03 | Phase 6 — tsc-rs WASM in-isolate | Planned |
| WASM-04 | Phase 6 — tsc-rs WASM in-isolate | Planned |
| WASM-05 | Phase 6 — tsc-rs WASM in-isolate | Planned |

**Coverage:**
- v1 requirements: 21
- Mapped to phases: 21
- Unmapped: 0 ✅

> Note: the initialized count said 19; corrected during roadmap creation — the original tally omitted OBS-01 and OBS-02 (3 RUN + 5 CORE + 4 TYPE + 4 SAND + 3 LLM + 2 OBS = 21).

---
*Requirements defined: 2026-10-10*
*Last updated: 2026-10-11 after roadmap creation — all 21 v1 requirements mapped to phases*
