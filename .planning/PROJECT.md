# iso-agents

## What This Is

A prototype of an AI coding agent that lives entirely inside a Cloudflare workerd
isolate (a Cloudflare Worker run via `wrangler dev`). Given a small coding task and a
spec, the agent generates TypeScript, type-checks it inside the isolate, executes it in
a WASM sandbox, reads the diagnostics, and iterates until the code is green — all
within a single request. It is a working exploration of the scenario highlighted by the
tsc-rs announcement (Rust port of the TypeScript 7 compiler): fast type-checking is
what makes an agent's write→check→run→fix loop viable inside request-scoped isolates.

## Core Value

The full agent loop — generate → type-check in-isolate → execute in-sandbox → feed
errors back → fix — must demonstrably run end-to-end inside workerd, observable via HTTP
with per-step timings.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Worker runs locally under real workerd (`wrangler dev`) and exposes `POST /agent/run`, `GET /healthz`, `GET /agent/run/:id`, `POST /typecheck`
- [ ] Agent loop iterates: LLM → in-memory VFS write → in-isolate type-check → transpile → QuickJS-WASM sandbox execution → spec assertions → error feedback → retry until green or max iterations
- [ ] In-isolate type-checking produces real TypeScript diagnostics without touching the host filesystem
- [ ] Sandbox execution is safe under workerd's no-eval rules (QuickJS compiled to WASM, no host `eval`/`new Function`)
- [ ] LLM provider is pluggable; deterministic mock provider demos the loop with zero API keys; OpenAI-compatible provider activates via env vars
- [ ] Per-step timings captured (LLM ms, type-check ms, sandbox ms) and returned; `POST /typecheck` measures in-isolate type-check latency standalone
- [ ] tsc-rs context documented: where it slots in (native today, no WASM yet), with clean seam (Typechecker interface) for a future drop-in

### Out of Scope

- Durable Objects / KV / Queues persistence — prototype keeps state in isolate memory; simpler, no billing/account needed
- Real deployment to Cloudflare production — prototype targets local `wrangler dev` only
- Streaming UI / chat front-end — HTTP + JSON is enough to observe the loop
- tsc-rs inside the worker runtime — it ships native binaries only (linux-x64/arm64, darwin-arm64), no WASM build yet; documented as future path instead
- Agent tools beyond code generation (web search, shell, package installs) — the loop is code→check→run→fix only

## Context

- Trigger: Theo's tsc-rs announcement video (https://www.youtube.com/watch?v=ND_kRgU_WlY) — 1.3M-line LLM-written Rust port of tsc 7, ~1.6x faster than tsgo, ~11x faster than JS tsc; published as `tsc-rs` on npm v0.2.0 (native platform binaries + unstable JS API, no WASM).
- The interesting scenario for this project: an agent resident in a workerd isolate doing tight generate/type-check/execute loops per request, where type-check speed dominates loop latency.
- In-isolate type-checking stands in with the official `typescript` npm package (pure JS, workerd-compatible); tsc-rs is the fast native path of the future — the design keeps a Typechecker seam for it.
- Execution of agent-generated code must not use host dynamic eval (workerd disallows it); QuickJS compiled to WASM runs the code inside the same isolate.
- Empty greenfield repo at `/home/projects/iso-agents`; sandbox has node 24 / npm 11, network access to npm; no Cloudflare account needed for local dev.

## Constraints

- **Tech stack**: Cloudflare Workers toolchain (wrangler + workerd via `wrangler dev`), TypeScript — matches the scenario being prototyped
- **Environment**: no Cloudflare account/API tokens; local dev only — prototype must not require paid services
- **Dependencies**: minimal; prefer small, well-maintained libraries (QuickJS-WASM runtime, pluggable LLM SDK) — prototype clarity over feature surface
- **Credentials**: zero API keys required to demo — mock LLM provider is the default; real provider is opt-in via env
- **Performance**: per-step timings must be measured, not asserted — the tsc-rs story is quantitative

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Run under `wrangler dev` (real workerd), not Node | The claim being prototyped is "agent inside workerd" | — Pending |
| TypeScript package for in-isolate type-check, behind a Typechecker interface | Pure JS works in workerd today; tsc-rs has no WASM yet — seam keeps the swap cheap | — Pending |
| QuickJS-WASM sandbox for executing generated code | workerd forbids host dynamic eval; WASM sandbox is the production-safe pattern | — Pending |
| Deterministic mock LLM provider as default | Prototype must demo end-to-end with zero keys; loop logic is the deliverable | — Pending |
| In-memory run store, no DO/KV | Prototype scope; isolate memory is enough to observe runs | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-10-10 after initialization*
