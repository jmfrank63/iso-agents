# Plan 01-01 Summary

**Status:** completed

## What was built

- **Task 1 — project config:** `package.json` with exact pins (wrangler 4.149.0, typescript 6.0.3, @cloudflare/workers-types 5.20261010.1; vitest 4.1.11 + @cloudflare/vitest-plugin 1.4.0 for 01-02), `tsconfig.json` (strict, ES2022, bundler resolution, workers-types), `.gitignore`. Scripts: `dev`, `check`, `bundle:check` (no deploy script).
- **Task 2 — wrangler config:** `wrangler.jsonc` (compatibility_date 2026-09-01, **both** `no_nodejs_compat` + `no_nodejs_compat_v2` flags — required opt-out at this date so `process` never exists for Phase 2), observability enabled, `rules` placeholder comment for Phase 2 lib .d.ts Text rule. `.dev.vars.example` with LLM_* + AGENT_MAX_ITERATIONS=5 + SANDBOX_TIMEOUT_MS=2000.
- **Task 3 — worker source:** `src/index.ts` (json/fail envelope helpers, HttpError, switch router, GET /healthz with `getRuntimeInfo()` seam, 404/405+Allow/501 for registered-but-unbuilt routes, 500 catch-all, parseJsonBody for later phases) + `src/runs.ts` (run registry seam: `crypto.randomUUID()` ids, RunStatus enum, Map store).
- **Task 4 — build gates:** `npm run check` exit 0; `npm run bundle:check` exit 0 (4.24 KiB bundle); zero `node:` refs in dist-bundle; `not_implemented` literal survives in bundle. No commit (outputs are gitignored; gates recorded here).
- **Task 5 — README + live smoke:** README (commands + smoke test, non-empty userAgent expectations). Live `wrangler dev` verified all 5 route behaviors with correct envelopes.

## Files created/modified

| File | Task | Commit |
|------|------|--------|
| package.json, package-lock.json, tsconfig.json, .gitignore | 1 | e8d7f78 |
| wrangler.jsonc, .dev.vars.example | 2 | 04e1ddb |
| src/index.ts, src/runs.ts | 3 | 0de1066 |
| src/index.ts (uptime fix) | 3/4 follow-up | 861c634 |
| README.md | 5 | 9110787 |

## Verification results

- `npm run check` → exit 0 (strict tsc, typescript 6.0.3)
- `npm run bundle:check` → exit 0, `dist-bundle/index.js` written, zero `node:` builtins, `not_implemented` ×1
- Live workerd smoke (`CI=true npm run dev`, port 8787):
  - `GET /healthz` → `{"ok":true,"data":{"status":"ok","runtime":{workerd:"Cloudflare-Workers",compatibility_date:"2026-09-01",typechecker:"unloaded",sandbox:"unloaded",instanceId:uuid,uptime_s,userAgent:"Cloudflare-Workers"}}}`
  - `POST /typecheck` → 501 `not_implemented` (registered)
  - `GET /agent/run/:unknown-id` → 404 `not_found` + detail
  - `DELETE /healthz` → 405 `method_not_allowed` + allow hint
  - `GET /nope` → 404 `not_found`

## Deviations from plan

1. **uptime bug found in live smoke:** plan's `const BOOT_MS = Date.now()` at module scope reads ~0 because workerd freezes `Date.now()` in global scope — first healthz returned `uptime_s: 1791750271` (≈ epoch/1000). Fixed with lazy `bootMsOnce()` memoization (same pattern as instanceId); re-smoked, `uptime_s: 0` correct. Committed as 861c634. (This is PITFALLS.md's frozen-clock pitfall surfacing exactly as predicted — relevant to Phase 3 sandbox interrupts.)
2. `README.md` includes an extra `npm run bundle:check` command bullet (plan's grep criterion `npm run dev` → 2 still holds).

## Commits

- e8d7f78 feat(01-01): project config — package.json (exact pins), tsconfig.json, .gitignore
- 04e1ddb feat(01-01): wrangler.jsonc (no_nodejs_compat opt-out) + .dev.vars.example
- 0de1066 feat(01-01): worker source — envelope, switch router, /healthz, run registry seam
- 861c634 fix(01-01): lazy boot-time capture — workerd freezes Date.now() at module init
- 9110787 docs(01-01): README with commands + workerd smoke test
