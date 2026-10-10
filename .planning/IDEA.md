# Idea: iso-agents — an AI coding agent that lives inside a Cloudflare workerd isolate

## Source context

Theo's announcement of tsc-rs ("You can rewrite typescript in rust for $420k",
https://www.youtube.com/watch?v=ND_kRgU_WlY): a 1.3M-line Rust port of the TypeScript 7
compiler, written by LLM agents, ~1.6x faster than tsgo and ~11x faster than JS tsc,
passing all 181,711 ported tests. Published as `tsc-rs` on npm (v0.2.0, native binaries
for linux-x64/linux-arm64/darwin-arm64, no WASM build yet, plus an unstable JS API).

The scenario we care about: **an agent running inside an isolate (Cloudflare workerd)** —
where the agent generates TypeScript, type-checks it, executes it, reads the errors, and
fixes its own code, all within one request-scoped isolate. Fast type-checking (the tsc-rs
promise) is what makes that loop viable inside a request budget.

## What to build (prototype)

A Cloudflare Worker (run with `wrangler dev`, which is real workerd) that hosts an
autonomous coding agent entirely inside the isolate:

1. `POST /agent/run` receives a small coding task with a spec (e.g., "implement
   `slugify` to this spec" or "write a function that passes these tests").
2. The agent loop, inside the worker: LLM call → write TypeScript into an in-memory
   virtual filesystem → **type-check in-isolate** → transpile TS→JS → **execute inside a
   QuickJS-WASM sandbox in the same isolate** → run the spec's assertions → feed failures
   (type errors or test failures) back to the LLM → repeat until green or max iterations.
3. The response returns the transcript, per-iteration diffs, type-checker diagnostics,
   sandbox output, and per-step timings (the "why fast type-checking matters" story).
4. `GET /healthz`, `GET /agent/run/:id` (recent in-memory runs), and a `POST /typecheck`
   endpoint that just measures in-isolate type-check latency for a snippet (the tsc-rs
   benchmark hook).

## Constraints and notes

- Prototype: in-memory state is fine, no Durable Objects/KV required (recommended
  default), minimal dependencies.
- LLM provider must be pluggable; ship a deterministic scripted mock provider so the
  whole loop demos end-to-end with zero API keys, and real providers (OpenAI-compatible
  endpoint via env vars) light up when keys are present.
- In-isolate type-checking uses the official `typescript` npm package (pure JS, runs in
  workerd) as the stand-in for tsc-rs, with clean seams (a Typechecker interface) so a
  tsc-rs WASM build slots in later; the timings endpoint exists to make that story
  measurable.
- Sandbox execution must survive workerd's no-eval rules: QuickJS compiled to WASM
  running inside the isolate (no dynamic eval in the host runtime).
- Everything must actually run locally with `wrangler dev` in this sandbox and be
  verifiable with curl.
