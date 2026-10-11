# Feature Landscape
**Domain:** in-isolate coding agent runtime | **Researched:** 2026-10-10

## Context: two schools of sandboxed code-exec agents

Everything in this space splits into two camps, and iso-agents' feature set should be
chosen against the camp it belongs to:

- **Out-of-process microVM school** — e2b (Firecracker VMs per sandbox, pause/resume that
  saves filesystem *and* memory), Vercel Sandbox (Firecracker microVMs, "start in
  milliseconds", snapshots, Active-CPU billing), Cloudflare Sandbox Containers (microVM
  with own kernel, Durable Object-scheduled). These optimize for **environment richness**:
  shells, files, package installs, long-lived processes, coding agents like Claude Code
  running inside.
- **In-isolate school** — TS Playground / `@typescript/vfs` (full `ts.createProgram`
  type-check in a browser with an in-memory file system), quickjs-emscripten (untrusted JS
  in WASM, "supports browsers, NodeJS, Deno, Bun, Cloudflare Workers"), Cloudflare Dynamic
  Workers / Worker Loader (load an untrusted module as a new Worker at runtime with
  `globalOutbound: null`), Cloudflare Agents SDK's "Code Mode" (`@cloudflare/codemode`: LLMs
  generate executable TypeScript instead of tool calls) and `@cloudflare/shell` (sandboxed
  JS execution + virtual filesystem), Val Town (user/AI-written vals deployed in ~100ms on
  isolates). These optimize for **request-scoped, zero-provision loops**.

iso-agents is squarely in the second school, so its features should maximize **observability
of the loop** (transcript, diagnostics, timings) rather than environment richness (files,
shells, installs). That single principle drives every recommendation below.

Notably, Cloudflare's Agents SDK feature list is the "production version" of this exact
prototype: Code Mode (generate TS, not tool calls), sandboxed execution in an isolated
Worker with a VFS, runtime bundling (`@cloudflare/worker-bundler`), built-in observability
(tracing, metrics, structured logs). iso-agents is a hand-rolled, single-request slice of
that stack — which is fine; the point is demonstrating the type-check-speed thesis.

## Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---|---|---|---|
| Task spec intake (structured body) | Every comparable runtime has a first-class "run this" entry point (e2b `Sandbox.create` + `commands.run`; Vercel `sandbox run`/SDK; Val Town HTTP vals) | Low | `POST /agent/run` accepts `{task, assertions[], options{maxIterations, sandboxTimeoutMs}}`; validate and echo the spec back in the response so runs are self-describing |
| Multi-iteration loop w/ error feedback | This *is* the product; the evaluator/critic pattern is documented in cloudflare/agents' Anthropic Patterns guide; Townie/codemode do generate→run→fix | Med | Loop logic is simple; the hard part is the loop *state*: capture per-iteration records as you go, don't retrofit |
| Iteration transcript in response | All agent stacks expose step history (cloudflare/agents persists chat messages; e2b returns command output; agent conventions everywhere) | Low | Append-only array: iteration #, LLM output (code), type-check diagnostics, sandbox result, assertion results, timings. Data loss here is unrecoverable later — build on iteration 1 |
| Structured TS diagnostics | TS Playground/twoslash established {message, file, line, character, code} diagnostics as the interface to compile errors; the LLM feedback needs them machine-readable | Low | `ts.getPreEmitDiagnostics` → flat JSON. Filter to errors/warnings (drop hints) before feeding back — diagnostic noise is the #1 loop-quality risk |
| Per-step timings | The whole tsc-rs thesis is quantitative; Vercel bills agent sandboxes on Active CPU precisely because wall-vs-active time matters for agent loops. Core Value says "measured, not asserted" | Low | `performance.now()` around each phase (LLM, type-check, transpile, sandbox, assert) per iteration + run total. workerd supports it |
| Health endpoint | Universal (`/healthz` on every agent runtime; e2b/Vercel expose sandbox/infra status) | Low | Return version, TS version, provider in use (mock/openai), QuickJS WASM warm/cold — free debuggability for demos |
| Run inspection endpoint | e2b and Vercel both model sandboxes as addressable objects with GET-able state; lets a curl demo re-inspect without re-running | Low–Med | In-memory `Map<id, RunRecord>` keyed by `crypto.randomUUID()` (native in workerd). Respond 404 with a body noting runs are isolate-lifetime — set expectations honestly |
| Max-iteration / cost guardrail | Every agent framework bounds the loop (max-steps in agent SDKs; Vercel/e2b bound sandbox lifetime and bill CPU) | Low | Default 3–5 iterations. Terminal status `maxed-out` must be distinct from `green` and `error` — a loop that exhausts budget is a *result*, not a crash |
| Sandbox execution timeout + memory cap | quickjs-emscripten ships this as API: `shouldInterruptAfterDeadline`, `memoryLimitBytes`, `runtime.setMemoryLimit`, `setMaxStackSize`. Vercel/e2b kill runaway commands. First `while(true)` the LLM writes will hang `wrangler dev` without it | Low | It's an argument to `evalCode`. Report timeout as a structured failure fed back to the LLM, never a thrown 500 |
| In-memory VFS as compiler host | `@typescript/vfs` exists precisely for this ("run TypeScript projects in-memory in a browser or node"); TS Playground uses it via the playground worker | Low–Med | Only the run's files + default lib.d.ts. No npm resolution — generated code must be dependency-free (state this in the spec intake docs) |
| Run-level wall-clock budget | workerd caps request duration; per-sandbox timeout doesn't bound the *whole* loop (N iterations × check+run). e2b/Vercel bound sandbox lifetime for the same reason | Low | Hard deadline checked between iterations; on breach, return partial transcript with status `deadline-exceeded` |
| Deterministic mock LLM provider | Zero-key demo is a stated constraint; comparable demos (playgrounds, codemode examples) all run without live secrets | Low–Med | The mock must be **stateful across iterations** (emit a deliberately broken v1, then fix based on the fed-back errors) or the loop demo is fake. Fixture keyed to bundled example tasks |
| Machine-readable final status | Composability: `green \| typecheck-failed \| tests-failed \| sandbox-timeout \| deadline-exceeded \| maxed-out \| internal-error` | Low | Single `status` + `reason` field. Without this, every consumer re-parses the transcript to know what happened |

## Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---|---|---|---|
| Typechecker seam with a *second* implementation | The actual thesis (tsc-rs drop-in). A seam with one impl is a guess; two impls is a design. Cheap proof: a `transpile-only` checker and/or a `noop` checker selectable via query param | Low | Interface: `check(files) → {diagnostics, ms}`. Document the constraint in the interface itself: tsc-rs ships native binaries only (linux-x64/arm64, darwin-arm64), no WASM — future slot is server-side, not in-isolate |
| `POST /typecheck` with N-run stats | The tsc-rs benchmark hook. Returning median/p50 of N runs + TS version + config makes the number citable, like playground compile-latency folklore | Low | Accept `{code, config?, runs?}`; return diagnostics + ms distribution. Nearly table stakes for this project (it's in the spec) — the stats flourish is the differentiator |
| Per-iteration diffs (vₙ → vₙ₊₁) | Makes self-correction *legible* — the demo money-shot; IDEA.md already promises it | Low–Med | Store full file per iteration in transcript, compute diff at read time with a ~40-line line-diff (don't pull a diff dependency) |
| Incremental type-check across iterations | The real "fast loop" demo: reuse the TS `Program` between iterations (small edit → cheap re-check) — the concrete mechanism tsc-rs promises to make trivial | Med–High | Plain `typescript` package can do it (`createProgram` with `oldProgram`) but program-reuse bugs are subtle. Prototype can ship wall-time for full checks and *document* incremental as the tsc-rs payoff |
| Wall-vs-CPU framing of timings | Vercel's Active-CPU pricing exists because agent wall time is dominated by waiting (they cite research: 71–98% of agent runtime is waiting on inference). iso-agents' twist: with a mock LLM there's no wait, so type-check *is* the wall time — sharpen that claim | Low (as documentation) | workerd exposes wall-clock (`performance.now`) but little reliable CPU-time API; honest move: report wall + note that in-isolate type-check is synchronous, so wall≈CPU during check. Don't fake CPU numbers |
| SSE/streaming progress | Live loop observation; cloudflare/agents has resumable streaming for chat | Med | workerd handles SSE fine, but with a mock LLM the whole run finishes in <1s — streaming demos nothing. Only worth it if a real-LLM demo is imminent; polling `GET /agent/run/:id` gives 80% of the value for 20% of the work |
| Run artifacts as downloadable JSON | Transcript becomes a reusable fixture (tests, blog posts, benchmark comparisons); mirrors e2b's results-export ethos | Low | `GET /agent/run/:id?download=1` with `Content-Disposition: attachment` — trivial once transcript exists |
| In-sandbox assertion harness | Spec assertions run *inside* QuickJS with the generated code, returning structured `{name, pass, error}` — far tighter LLM feedback than raw stack traces | Med | Inject only `console` + `assert` host functions. Keep the assertion-result shape stable; it's the loop's feedback contract |
| Prompt-injection hardening notes | Honest attack-surface doc: spec text and (later) fed-back error text are untrusted; the real boundary is host-function exposure to QuickJS, not the LLM prompt | Low (docs) / Med (hardening) | Minimum: sandbox gets zero host functions except injected assert/console; size caps on spec+code; NOTES.md documenting why. Real prompt-injection defense is out of prototype scope |

## Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|---|---|---|
| Auth / API keys / rate limiting | Local `wrangler dev` demo, single user; every guard adds friction to the thesis demo | README note: "local prototype, no auth — do not expose publicly". Per-run size caps (spec/code bytes) are the only input hygiene worth having |
| Persistence (Durable Objects / KV / R2) | Already declared out of scope; DO adds billing, migrations, and a second runtime model — none of which the type-check-speed thesis needs. In-memory store also *demonstrates* the request-scoped claim | `Map` in isolate memory + explicit "runs die with the isolate" docs on the 404 body of `GET /agent/run/:id` |
| UI / chat front-end | cloudflare/agents ships a whole playground app; that's a product, not a prototype. JSON is the interface; curl + jq is the dashboard | Pretty-printed JSON responses + the downloadable artifact. Optional: zero-UI trick of returning an `text/html` transcript via query param only if demoing to non-devs (skip it) |
| Production deploy (workers.dev / account) | Prototype targets local only; deploy adds account/tokens and invites "real traffic" problems (auth, limits) that are anti-features | `wrangler dev` + curl script (`demo.sh`) that runs the whole happy path |
| Agent tools beyond the loop (web search, shell, package install, file edits) | Declared out of scope; each tool multiplies sandbox surface. Environment richness is the *other* school's game | Keep the loop code→check→run→fix. The VFS holds exactly the run's files |
| Multi-file projects / module resolution / bundling | `@cloudflare/worker-bundler` shows how much machinery runtime bundling is; npm resolution breaks the zero-network, zero-key demo | Single entry file + compiler's default lib. `@typescript/vfs` gives the lib files in-memory; reject imports with a clear diagnostic fed back to the LLM |
| Token accounting / prompt caching | Mock provider has no tokens; real-provider token meters are production concerns with zero prototype value | Report **LLM call count** and per-call latency only |
| Sandbox-escape hardening beyond defaults | QuickJS-WASM with no host functions is already the security model; hardening *beyond* it (seccomp, syscall filters) belongs to the microVM school | Freeze the policy: QuickJS + interrupt deadline + memory limit + zero host functions (except assert/console), documented once |

## Feature Dependencies

```
request schema + status model + in-memory run registry (ids)
  → every endpoint

LLM provider seam (interface) + mock provider
  → agent loop

in-memory VFS (@typescript/vfs-style)
  → in-isolate type-check (typescript package)
    → structured diagnostics extraction
      → error feedback to LLM
        → multi-iteration loop

Typechecker interface (seam)
  → ts-package checker impl
  → transpile-only/noop checker impls (proves the seam)
  → POST /typecheck benchmark endpoint

transpile (ts.transpileModule)
  → QuickJS runtime init (interrupt deadline + memory limit)
    → sandbox executor
      → in-sandbox assertion harness
        → loop assertion results

agent loop (composes provider + checker + executor + harness)
  → transcript capture (in-loop, from iteration 1)
    → GET /agent/run/:id
    → per-iteration diffs (computed at read)
    → artifact download

per-step timing wrapper
  → per-iteration + per-run timings
    → POST /typecheck stats
    → the quantitative tsc-rs story

hard requirement ordering: sandbox timeout/memory limits MUST exist before the
loop's first real (non-fixture) run — an LLM-written `while(true)` without
shouldInterruptAfterDeadline hangs wrangler dev with no recovery.
```

## MVP Recommendation

One-sitting build order, each step independently curl-verifiable:

1. **Worker skeleton**: Hono-or-plain router, `/healthz`, JSON error contract, in-memory
   run registry with `crypto.randomUUID()`, status model enum.
2. **Type-check core (the thesis)**: VFS + Typechecker interface + `typescript`-package
   impl returning structured diagnostics; `POST /typecheck` with wall-ms (+ median of N).
   This is the riskiest integration (TS package inside workerd) — de-risk it first.
3. **QuickJS executor**: quickjs-emscripten (Workers variant loading per its Cloudflare
   example), `shouldInterruptAfterDeadline` + `memoryLimitBytes` from day one, injected
   `console`/`assert`, structured assertion results. Second-riskiest integration — second.
4. **Mock LLM + provider seam**: fixture-based, stateful across iterations (broken v1 →
   fixed v2 on error feedback); OpenAI-compatible impl behind env vars, untested but typed.
5. **Agent loop**: compose 2–4 with max-iterations, run deadline, per-step timings,
   transcript capture. `POST /agent/run` returns full transcript + final status.
6. **`GET /agent/run/:id`**: replay any recent run.

If time remains, in this order: per-iteration diffs (read-time, no dep) → artifact
download (`?download=1`) → /typecheck N-run stats. Explicitly **defer**: SSE streaming,
incremental program reuse (document as the tsc-rs payoff instead), prompt-injection
hardening beyond the no-host-fn policy + notes, multi-file support.

The demo narrative falls out for free: same task, mock LLM, curl → JSON with
`typecheckMs` front and center, plus `/typecheck` numbers proving "the check is cheap
enough to do N times per request" — which is the entire reason this prototype exists.

## Sources

| Source | What it grounded | Confidence |
|---|---|---|
| Cloudflare Sandbox docs — developers.cloudflare.com/sandbox (fetched 2026-10-10) | Containers vs Dynamic Workers; Worker Loader with `globalOutbound: null` as sanctioned untrusted-exec path; "Build an AI code interpreter" guide | High |
| cloudflare/agents README (github.com/cloudflare/agents, fetched 2026-10-10) | Production feature surface: Code Mode (`@cloudflare/codemode`), `@cloudflare/shell` sandboxed JS + VFS, `@cloudflare/worker-bundler`, observability (tracing/metrics/logs), Anthropic Patterns evaluator guide | High |
| Vercel Sandbox docs — vercel.com/docs/sandbox (fetched 2026-10-10) | Firecracker microVM model, ms startup, snapshots/persistence; Active-CPU pricing citing 71–98% of agent runtime waiting on inference (arXiv-linked); SDK/CLI surface | High |
| e2b docs — e2b.dev/docs (fetched 2026-10-10) | Sandbox lifecycle (create → commands.run → pause/resume saving fs+memory), templates, API-key model | High |
| quickjs-emscripten README (github.com/justjake/quickjs-emscripten, fetched 2026-10-10) | Explicit Cloudflare Workers support + workers-specific WASM variant loading example; `shouldInterruptAfterDeadline`, `memoryLimitBytes`, `setMemoryLimit`, `setMaxStackSize`, module loaders, ES-module eval | High |
| microsoft/TypeScript-Website README (fetched 2026-10-10) | `@typescript/vfs` ("run TypeScript projects in-memory in a browser or node"), `@typescript/sandbox`, twoslash (compile→diagnostics→render), playground-worker | High |
| Val Town docs — docs.val.town (fetched 2026-10-10) | "You—and your AI agent—write and run JavaScript, always deployed in 100ms"; Townie agent; built-in version control | High (for stated claims); Low–Med (inferences about internal exec model) |
| workerd dynamic-eval prohibition + unsafe-eval binding | Core constraint "no host dynamic eval → QuickJS-WASM route" | Medium — docs URL 404'd this session; corroborated indirectly by Cloudflare's Dynamic Workers as the sanctioned alternative and project docs |
| typescript-eslint playground typed-linting in browser | "Full type-check in a constrained JS runtime is viable" claim | Medium — not fetched this session; well-known but secondhand |
| tsc-rs figures (~11x vs JS tsc, ~1.6x vs tsgo, native-only, no WASM, 181,711 tests) | The thesis numbers and the "no WASM yet" seam constraint | Medium — secondhand from announcement video via project IDEA.md; not independently verified |
