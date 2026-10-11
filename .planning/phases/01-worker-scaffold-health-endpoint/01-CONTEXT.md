# Phase 1 Context: Worker scaffold + health endpoint

**Phase:** 01 — Worker scaffold + health endpoint
**Captured:** 2026-10-10 (auto mode — all decisions are recommended defaults, logged for audit)

## Decisions

### Test harness
[vauto] Q: "Which test harness?" → Selected: **vitest + @cloudflare/vitest-plugin** (recommended default).
Tests execute inside real workerd against the actual worker exports. Unit tests for pure
logic (envelope, timings shape) run in the same pool. If the plugin fights the WASM
dependencies in a later phase, fallback is integration tests via `wrangler dev` + curl
script — but plugin-first is the default.

### HTTP response envelope
[auto] Q: "What response shape?" → Selected: **uniform JSON envelope** (recommended default).
Success: `{"ok": true, "data": {...}}`. Failure: `{"ok": false, "error": {"code": string,
"message": string, "detail"?: unknown}}` with correct status codes (400 validation,
404 unknown run, 500 internal). Every endpoint — including health — uses it, so later
phases never negotiate format.

### Config plumbing
[auto] Q: "How is config/env plumbed?" → Selected: **typed `Env` from wrangler.jsonc +
workers-types, `.dev.vars` for optional secrets** (recommended default). Env vars needed
later (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, AGENT_MAX_ITERATIONS, SANDBOX_TIMEOUT_MS)
are documented in `.dev.vars.example` in Phase 1 so plumbing never changes shape again.

### Router style
[auto] Q: "Routing approach?" → Selected: **plain switch on pathname + method** (recommended
default). Four routes don't justify a framework; a `json()` helper centralizes the
envelope. Framework swap stays trivial because all routes funnel through one handler.

### Logging & timings
[auto] Q: "Logging approach?" → Selected: **console.\* with step prefixes and structured
timing fields** (recommended default). `[agent]`, `[typecheck]`, `[sandbox]` prefixes;
durations logged as flat fields (`typecheck_ms=12`). No logging dependency; timings
collector interface lands in Phase 2.

## Notes for downstream agents

- Phase is deliberately boring: its job is a rock-solid, verifiable foundation —
  `wrangler dev` up, `GET /healthz` green, TypeScript build clean, one integration test
  passing inside workerd.
- `healthz` payload already includes placeholder identities (`typechecker: "unloaded"`,
  `sandbox: "unloaded"`) so Phases 2–3 fill them in without an API change.
- Boot-time module loading (later phases) must keep `/healthz` fast; lazy-init seams go
  in the scaffold now (a `getRuntimeInfo()` stub).
