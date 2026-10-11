# Roadmap: iso-agents

**Project:** iso-agents (see [PROJECT.md](PROJECT.md))
**Milestone:** v1
**Defined:** 2026-10-11
**Project code:** ISO
**Granularity:** coarse — 4 phases, 1–3 execution plans each
**Requirements source:** [REQUIREMENTS.md](REQUIREMENTS.md) — 21 v1 requirements, 100% mapped

## Overview

iso-agents proves one claim: the full agent loop — generate → type-check in-isolate → execute in-sandbox → feed errors back → fix — runs end-to-end inside a workerd isolate under `wrangler dev`, observable over HTTP with per-step timings. The roadmap is a strict dependency chain (registry → type-check → sandbox → loop → inspection) in which both high-risk integrations are spiked before anything composes on them: Phase 1 stands up the worker scaffold, build gates, and route skeleton (risk-free); Phase 2 builds the thesis itself — real TypeScript diagnostics inside the isolate via a fully in-memory compiler host — and consumes the research-flagged typescript pin spike (pure-JS `6.0.3` vs `~5.9.3`, never native 7.x); Phase 3 builds the only legal execution path under workerd's no-eval rules — a QuickJS-WASM sandbox whose guardrails (deadline, memory, single-use contexts) exist before the loop ever runs; Phase 4 composes everything into the agent loop behind pluggable LLM providers (deterministic broken-first mock by default, zero API keys) and consolidates observability — per-step timings are woven in from their first touch in Phases 2–3, culminating in the `/typecheck` N-run benchmark stats and the run-inspection endpoints. Every phase is independently curl-verifiable under `wrangler dev`; execution plans per phase are created by `/gsd-plan-phase`.

## Phases

### Phase 1: Worker scaffold + health endpoint

**Goal:** A TypeScript Cloudflare Worker that builds clean and runs under real workerd via `wrangler dev` (no Cloudflare account or API tokens), with the four-route URL-switch skeleton, structured JSON error envelope, and the in-memory run registry + status model that every later phase composes on. Build tooling gates (tsc, no Node builtins in the bundle) are in place from day one.

**Requirements:** RUN-01, RUN-02, RUN-03

**Success Criteria:**
1. `wrangler dev` boots the worker under real workerd with no Cloudflare account or API tokens, and `GET /healthz` returns 200 JSON with runtime identity: workerd version, compatibility date, typechecker and sandbox identities, and isolate `instanceId`.
2. TypeScript build passes and the worker bundle is clean — a dry-run bundle gate proves zero Node builtins in the bundle.
3. All four routes are registered (`POST /agent/run`, `GET /healthz`, `GET /agent/run/:id`, `POST /typecheck`); not-yet-implemented routes return the structured JSON error envelope rather than crashing or hanging.
4. The in-memory run registry is live (ids via `crypto.randomUUID()`, status enum defined) — `GET /agent/run/:id` for an unknown id already returns the honest structured 404.

**Plans:** to be created by /gsd-plan-phase

### Phase 2: In-isolate type-check core

**Goal:** Real TypeScript diagnostics produced entirely inside the isolate with zero host filesystem access — the riskiest integration, spiked first: the in-workerd build spike decides the typescript pin (research conflict: `6.0.3` per STACK vs `~5.9.3` per PITFALLS; both agree 7.x native tsgo is forbidden) and whether `nodejs_compat`/compat-date interacts with typescript's Node sys detection. Builds the in-memory VFS, a fully hand-rolled CompilerHost (never `ts.sys`/`ts.createCompilerHost`), lib `.d.ts` inlined as bundled text, the `Typechecker` interface (tsc-rs seam), and the timing-fidelity foundation.

**Requirements:** TYPE-01, TYPE-02, TYPE-04

**Success Criteria:**
1. The pin decision is made by the spike and locked in `package.json` with recorded rationale; a boot-time identity assert fails loudly on an accidental upgrade to native TS, and `/healthz` reports the pinned TS version.
2. A curl-able check path (early `POST /typecheck`, single-run wall-ms; N-run stats land in Phase 4) returns structured diagnostics `{code, message, file, line}` for posted snippets — produced by the in-memory VFS + hand-rolled CompilerHost with lib `.d.ts` strings bundled as text, provably touching no host filesystem.
3. A second trivial `Typechecker` implementation (transpile-only/noop) is selectable, proving the interface is a genuine seam for a future tsc-rs WASM drop-in.
4. The timing-fidelity micro-test demonstrates measured type-check ms is non-zero for real checks under the dual-clock strategy (`performance.now()` + `Date.now()`), with lib SourceFiles memoized to bound 128 MB isolate churn — the foundation OBS-01 builds on.

**Plans:** to be created by /gsd-plan-phase

### Phase 3: QuickJS-WASM sandbox executor

**Goal:** Generated JS executes safely inside QuickJS-WASM in the same isolate — the second-riskiest integration, with the variant-loading spike (singlefile-embed vs `import wasm + newVariant({wasmModule})`), and every guardrail in place before the agent loop's first real run (research hard requirement: a `while(true)` guest without limits hangs `wrangler dev` unrecoverably). Includes the transpile step feeding the sandbox, fresh single-use contexts, counter-based interrupt deadline, memory + stack limits, console shim, and the in-sandbox assertion harness.

**Requirements:** SAND-01, SAND-02, SAND-03, SAND-04

**Success Criteria:**
1. A `while(true){}` guest returns a structured timeout result via the counter-based interrupt + deadline (since `Date.now()` freezes during sync guest execution) — `wrangler dev` never hangs.
2. Memory limit and max stack size are enforced; a crashed or stack-overflowing guest cannot poison the next execution — fresh single-use context per run, dispose discipline in `finally`.
3. Guest console output is captured and returned; guest code cannot reach host state, fetch, or the VFS — zero host functions exposed except injected `console`/`assert`.
4. A CI/grep gate proves no host `eval`/`new Function` anywhere in the shipped worker — QuickJS-WASM is the only execution path.
5. The in-sandbox assertion harness returns structured `{name, pass, error}` results for spec assertions, and transpiled TS guest source executes end-to-end.

**Plans:** to be created by /gsd-plan-phase

### Phase 4: Agent loop + LLM + observability

**Goal:** The core value demonstration: compose the type-checker and sandbox behind pluggable LLM providers into the request-scoped agent loop — `POST /agent/run` runs generate → type-check → transpile → sandbox → assert → fix to green or a distinct guardrail, with the transcript captured from iteration 1 and per-step timings woven in (already seeded in Phases 2–3). The final consolidating plan completes the observability surface: `/typecheck` N-run benchmark stats and the `GET /agent/run/:id` run store.

**Requirements:** CORE-01, CORE-02, CORE-03, CORE-04, CORE-05, LLM-01, LLM-02, LLM-03, TYPE-03, OBS-01, OBS-02

**Success Criteria:**
1. `curl -X POST /agent/run` with `{task, spec}` runs the full loop with the default deterministic mock provider — zero API keys; the mock is stateful and deliberately imperfect (broken first response with markdown fences → error-driven fixes), demonstrable by `iterations >= 2` on the bundled fixture.
2. Type errors gate execution — a failing type-check skips the sandbox and feeds diagnostics straight back to the LLM — and the run terminates with a distinct status (`success`, `max_iterations`, `deadline`, `llm_error`).
3. The response carries the full transcript: per-iteration LLM output, written files, type diagnostics, sandbox stdout/result, assertion results, and failure-feedback text.
4. `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` env vars activate the OpenAI-compatible provider with no code changes, and every step's wall-clock duration (LLM ms, type-check ms, transpile ms, sandbox ms, total ms) is in the response and stored with the run.
5. `POST /typecheck` type-checks a posted snippet N times and returns per-run latency stats (min/median/mean ms) — the tsc-rs benchmark hook — and `GET /agent/run/:id` returns the stored run (transcript + timings + status) with an honest 404 for unknown ids.

**Plans:** to be created by /gsd-plan-phase

## Milestone: v1 — definition of done

v1 is done when the core value is demonstrable end-to-end with curl, no API keys, under `wrangler dev`:

1. `GET /healthz` reports full runtime identity; the worker runs under real workerd with no Cloudflare account (RUN-01, RUN-02) and a clean, builtin-free bundle (RUN-03).
2. `POST /typecheck` returns real in-isolate diagnostics and N-run latency stats — the quantitative tsc-rs hook (TYPE-01..04).
3. `POST /agent/run` with the mock LLM runs the full loop to green or a distinct guardrail status, returning transcript + per-step timings (CORE-01..05, LLM-01, LLM-02, OBS-01).
4. `GET /agent/run/:id` replays a stored run, and env vars swap in the OpenAI-compatible provider with zero code changes (OBS-02, LLM-03).
5. All execution is sandboxed inside QuickJS-WASM with guardrails proven before the loop, and no host eval exists anywhere (SAND-01..04).
6. All 21 v1 requirements validated and moved to PROJECT.md "Validated"; tsc-rs seam and its native-only/no-WASM constraint documented at the `Typechecker` interface.

**The demonstration:** one curl to `POST /agent/run` returns, in seconds, a transcript in which a deliberately broken mock first draft fails type-check, receives structured diagnostics, fixes itself, and passes all spec assertions in the sandbox — with `typecheckMs` measured per iteration, and `POST /typecheck` stats proving the check is cheap enough to run N times per request. That is the entire thesis.
