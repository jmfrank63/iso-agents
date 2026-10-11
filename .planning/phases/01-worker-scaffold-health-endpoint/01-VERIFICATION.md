# Phase 1 Verification

**Verified:** 2026-10-11 (goal-backward, codebase + live re-run; all checks re-executed by verifier, not trusted from summaries)
**Verdict:** DELIVERED

## Requirements table

| Req | Verdict | Evidence: file:line / command output |
|-----|---------|--------------------------------------|
| RUN-01 — starts under real workerd via `wrangler dev`, no account/tokens | DELIVERED | `CI=true npm run dev` → `Ready on http://localhost:8787` (wrangler 4.149.0 / bundled workerd 1.20261006.1); no `.dev.vars` file exists (only `.dev.vars.example`), no login/token used; all 6 curls responded live |
| RUN-02 — `GET /healthz` returns 200 with runtime identity | DELIVERED | src/index.ts:79-91 (`getRuntimeInfo()`); live: 200 `{"ok":true,"data":{"status":"ok","runtime":{workerd:"Cloudflare-Workers",compatibility_date:"2026-09-01",typechecker:"unloaded",sandbox:"unloaded",instanceId:"b114e6a0-5319-4e5f-be2d-fccb0eb273c6",uptime_s:0,userAgent:"Cloudflare-Workers"}}}` |
| RUN-03 — builds with TS, bundles clean (no Node builtins) | DELIVERED | `npm run check` → exit 0 (strict tsc); `npm run bundle:check` → exit 0, 4.33 KiB / gzip 1.68 KiB; `grep -rEo 'node:[a-z_]+' dist-bundle/` → zero matches |

## Success criteria table

| SC# | Verdict | Evidence |
|-----|---------|----------|
| SC1 — workerd boots w/o account; `/healthz` 200 JSON w/ runtime identity (workerd, compat date, typechecker/sandbox ids, instanceId) | DELIVERED | Live curl (above): all fields present, instanceId is a valid 36-char UUID, `uptime_s: 0` sane integer, typechecker/sandbox `"unloaded"` per the Phase 2/3 placeholder contract. Note: `workerd` field is `navigator.userAgent` = `"Cloudflare-Workers"`, not a semver — workerd has no in-band version API; documented best-effort in src/index.ts:81-83, README.md:24-26, test/healthz.spec.ts:14-19 (asserted non-empty). Honest and consistent, but "workerd version" is satisfied in spirit, not literally |
| SC2 — TS build passes; dry-run bundle gate proves zero Node builtins | DELIVERED | `npm run check` exit 0; `npm run bundle:check` exit 0; `node:` grep on dist-bundle → no matches; `not_implemented` literal survives in bundle (grep count 1) |
| SC3 — all four routes registered; unimplemented routes return structured envelope | DELIVERED | src/index.ts:93-114 (`KNOWN_PATHS`, switch, 501 `not_implemented`); live: `POST /typecheck` → 501 `not_implemented`, `POST /agent/run` → 501 `not_implemented`; `GET /healthz` → 200; `GET /agent/run/:id` handled (404 path) |
| SC4 — run registry live (crypto.randomUUID, status enum); unknown id → honest structured 404 | DELIVERED | src/runs.ts:1-20 (`RunStatus` = running/success/max_iterations/deadline/llm_error; `create()` uses `crypto.randomUUID()`; Map store); live `GET /agent/run/00000000-…` → 404 `not_found` + `{id, hint}` detail; test/runs.spec.ts roundtrip + unknown-id tests pass |

## Locked-decision conformance

- **Uniform JSON envelope on every response** — conforms. `json()`/`fail()` helpers (src/index.ts:39-55) funnel all routes; `Envelope` union type at :35-37. All 6 live responses used it (200 ok / 501 / 404 / 405 / 404), including health.
- **Switch router, no framework** — conforms. `switch (`${method} ${pathname}`)` at src/index.ts:109; only import in src/ is `./runs` (grep confirmed); no hono/itty/express/koa references.
- **Typed `Env` interface** — conforms. src/index.ts:3-10 declares all six future vars (LLM_PROVIDER, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, AGENT_MAX_ITERATIONS, SANDBOX_TIMEOUT_MS) as optional strings.
- **`.dev.vars.example` contents** — conforms. Has LLM_PROVIDER=mock, commented LLM_BASE_URL/LLM_API_KEY/LLM_MODEL, AGENT_MAX_ITERATIONS=5, SANDBOX_TIMEOUT_MS=2000, plus copy-to-.dev.vars instructions.
- **vitest + @cloudflare/vitest-plugin (not deprecated pool-workers)** — conforms. package.json:13 `"@cloudflare/vitest-plugin": "1.4.0"`, vitest 4.1.11; vitest.config.ts:5 uses `cloudflareTest({ wrangler: { configPath } })`; zero `vitest-pool-workers` references anywhere (grep).
- **Both `no_nodejs_compat` flags** — conforms. wrangler.jsonc:11 `"compatibility_flags": ["no_nodejs_compat", "no_nodejs_compat_v2"]` with rationale comment (Phase 2 needs `process` absent).
- **typescript pinned exactly 6.0.3** — conforms. package.json:15 `"typescript": "6.0.3"` (exact pin, no range, not 7.x); installed `node_modules/typescript` version verified 6.0.3.
- **Boot-time lazy init for frozen-clock pitfall** — conforms. `bootMsOnce()`/`instanceIdOnce()` memoization (src/index.ts:16-26) per the 861c634 deviation; live `uptime_s: 0` confirms the fix holds.

## Gaps

- none material. One minor documented deviation (accepted, not a gap): `healthz`'s `workerd`/`userAgent` fields report `"Cloudflare-Workers"` (navigator.userAgent best-effort) rather than a workerd semver — workerd exposes no in-band version API; the deviation is explicitly documented in code comments, tests, and README, and real-workerd execution is proven independently by `wrangler dev` booting.

## Command log

```
npm run check                          → exit 0 (tsc --noEmit, strict)
npm test                               → exit 0; Test Files 2 passed, Tests 8 passed (1.76s)
npm run bundle:check                   → exit 0; Total Upload 4.33 KiB / gzip 1.68 KiB
grep -rEo 'node:[a-z_]+' dist-bundle/  → no matches (exit 1)
grep -c not_implemented dist-bundle/index.js → 1
CI=true npm run dev                    → Ready on http://localhost:8787 (~12s wait)
curl GET  /healthz                     → 200 ok envelope, runtime identity verified field-by-field
curl POST /typecheck                   → 501 {"error":{"code":"not_implemented"}}
curl POST /agent/run                   → 501 {"error":{"code":"not_implemented"}}
curl GET  /agent/run/00000000-0000-4000-8000-000000000000 → 404 not_found + {id, hint}
curl DELETE /healthz                   → 405 method_not_allowed + Allow: GET
curl GET  /nope                        → 404 not_found
pkill wrangler; curl /healthz          → connection refused (exit 7); no wrangler/workerd processes
grep src/ imports                      → only "./runs"; no framework refs; zero vitest-pool-workers refs
node -e require(typescript/package.json).version → 6.0.3
```
