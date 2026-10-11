# Phase 1 Research: Worker scaffold + health endpoint under real workerd

**Phase:** 01 — Worker scaffold + health endpoint
**Researched:** 2026-10-10

## Summary

Everything Phase 1 needs is verified and boring — which is the point. `wrangler@4.149.0` boots the real production runtime (workerd `1.20261006.1` bundled, esbuild `0.28.2`) locally with zero Cloudflare account or tokens; the minimal config is just `name` + `main` + `compatibility_date` (plus the `observability` object, whose schema is `{ enabled: boolean, head_sampling_rate?, ... }` — verified in wrangler's published `config-schema.json`). The test harness is `@cloudflare/vitest-plugin@1.4.0` — confirmed on npm that the old `@cloudflare/vitest-pool-workers` is deprecated with the notice "renamed to @cloudflare/vitest-plugin. This package will not receive future updates." — configured exactly as the current docs (updated 2026-10-08) show: `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })`, with integration tests calling `exports.default.fetch("http://example.com/healthz")` from the `cloudflare:workers` module. I inspected the plugin tarball: it exports `cloudflareTest`, its options schema accepts `main`, `wrangler.{configPath, environment}`, and `miniflare.workers`, and its `cloudflare:test` module provides `createExecutionContext`, `waitOnExecutionContext`, `SELF`, and `env`. Prerequisites are compatibility_date ≥ `2022-10-31` (ours is `2026-09-01`) and ES-modules-format worker (ours: `export default { fetch }`) — both satisfied.

**One material correction to project-level research, discovered during this phase:** STACK.md's wrangler config comment says "Deliberately NO nodejs_compat," but the official Node.js compatibility docs (updated 2026-08-12) state that **for compatibility dates ≥ `2026-08-04`, `nodejs_compat` and `nodejs_compat_v2` are enabled by default** — and our chosen date `2026-09-01` is past that line. Left uncorrected, the isolate would have a `process` global (Process API: "supported"), and typescript@6's `isNodeLikeSystem()` would take the Node branch in Phase 2 — exactly what the no-`process` assumption was designed to prevent. The docs give the opt-out: add **both** `no_nodejs_compat` and `no_nodejs_compat_v2` to `compatibility_flags`. The scaffold must ship these flags now (they're inert for a zero-dependency Phase 1 worker but they lock in Phase 2's environment), and they make the Phase 1 bundle gate *stricter*: with nodejs_compat off, any accidental `node:` import fails bundler resolution outright instead of silently stubbing via unenv.

Types wiring is cleaner than the docs suggest: no `wrangler types` / generated `worker-configuration.d.ts` needed. Verified by tarball inspection that `@cloudflare/workers-types@5.20261010.1` itself declares `namespace Cloudflare { interface Env {} }` (line 16382) **and** `declare module "cloudflare:workers"` (line 16687, exporting `env`/`exports`); the plugin's `@cloudflare/vitest-plugin/types` adds only the `cloudflare:test` module declarations. One root tsconfig with `types: ["@cloudflare/workers-types", "@cloudflare/vitest-plugin/types"]` type-checks worker source, vitest config, and tests together. Recommend exact pins (vitest `4.1.11`, not 5.x, even though 5.0.3 also satisfies the plugin's peer range `^4.1.0 || ^5.0.0` — docs and examples target 4.1.x), the integration-style healthz test as the single workerd smoke, and unit-style assertions (import the worker + `createExecutionContext()`) for envelope details.

## Version Matrix

| Package | Version | Verified via | Confidence |
|---|---|---|---|
| wrangler | 4.149.0 (bundles workerd 1.20261006.1, esbuild 0.28.2) | `npm view wrangler@4.149.0 dependencies` — workerd/esbuild present in dep manifest | HIGH |
| workerd (runtime under `wrangler dev`) | 1.20261006.1 | wrangler 4.149.0 dependency manifest | HIGH |
| @cloudflare/workers-types | 5.20261010.1 | `npm view`; tarball inspected: `namespace Cloudflare`+`interface Env` (L16382), `module "cloudflare:workers"` (L16687) | HIGH |
| typescript (host-side tsc gate; in-isolate in Phase 2) | 6.0.3 — pure-JS line | `npm view typescript@6.0.3 dist.tarball` → registry tarball exists; `latest` dist-tag = 7.0.2 (native tsgo — forbidden). Fallback 5.9.3 also verified present | HIGH |
| vitest | 4.1.11 (latest is 5.0.3 — in peer range but not docs line) | `npm view vitest@4.1.11 version`; plugin peers `^4.1.0 \|\| ^5.0.0` | HIGH |
| @cloudflare/vitest-plugin | 1.4.0 | `npm view` (peers `^4.1.0 \|\| ^5.0.0`); tarball inspected: exports `cloudflareTest`; `cloudflare:test` types provide `createExecutionContext`/`waitOnExecutionContext`/`SELF`/`env` | HIGH |
| @cloudflare/vitest-pool-workers | DEPRECATED — do not install | npm deprecation notice: "renamed to @cloudflare/vitest-plugin. This package will not receive future updates." | HIGH |
| compatibility_date | `2026-09-01` | ≤ bundled workerd's date (1.20261006.1); ≥ plugin's 2022-10-31 floor. **Requires the two `no_nodejs_compat*` flags below** | HIGH |
| compatibility_flags | `["no_nodejs_compat", "no_nodejs_compat_v2"]` | Cloudflare Node.js compat docs (updated 2026-08-12): nodejs_compat is default-ON at date ≥ 2026-08-04; opt-out = add both flags | HIGH |

## Recommended Setup

### wrangler.jsonc

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "iso-agents",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  // REQUIRED at this date: nodejs_compat (+v2) is default-ON for
  // compatibility_date >= 2026-08-04. Phase 2 depends on `process` NOT
  // existing (typescript@6 isNodeLikeSystem must stay false). Turning it
  // off also makes accidental `node:` imports fail the bundle instead of
  // silently stubbing through unenv.
  "compatibility_flags": ["no_nodejs_compat", "no_nodejs_compat_v2"],
  // Locally inert; correct production shape. Schema: {enabled, head_sampling_rate, redact_query_string, issues}
  "observability": { "enabled": true }
  // Phase 2 will append (lib .d.ts as text for the in-isolate checker):
  // "rules": [{ "type": "Text", "globs": ["**/*.d.ts"] }]
}
```

No `nodejs_compat`, no `type` field (wrangler infers ESM from `src/index.ts`), no bindings, no triggers — `wrangler dev` needs no account, no login, no API tokens.

### package.json (scripts + pinned devDeps)

```jsonc
{
  "name": "iso-agents",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "tsc --noEmit",
    "bundle:check": "wrangler deploy --dry-run --outdir dist-bundle"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "1.4.0",
    "@cloudflare/workers-types": "5.20261010.1",
    "typescript": "6.0.3",
    "vitest": "4.1.11",
    "wrangler": "4.149.0"
  }
}
// typescript@6.0.3 is devDependency-only in Phase 1 (host tsc gate). Phase 2 moves
// it to a regular dependency when the worker imports it for in-isolate checking.
// Exact pins, not carets: typescript@latest resolves to native 7.x (forbidden);
// vitest@5 also fits the plugin's peer range but docs/examples target 4.1.x.
```

`bundle:check` is the ROADMAP SC2 gate: `--dry-run` builds the bundle locally without uploading (no account needed), and with nodejs_compat disabled any `node:` import fails resolution. Optional CI hardening: `! grep -rEo 'node:[a-z_]+' dist-bundle` after the dry run.

### tsconfig.json

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    // workers-types: runtime API types + Cloudflare.Env + "cloudflare:workers" module.
    // vitest-plugin/types: adds only the "cloudflare:test" module declarations.
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-plugin/types"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

Verified: `@cloudflare/workers-types@5.20261010.1` provides `Cloudflare.Env` (the plugin's `cloudflare:test` types reference it) and the `cloudflare:workers` module — so the docs' `wrangler types` flow is unnecessary. `moduleResolution: "bundler"` pairs with `module: "ESNext"` (emission is wrangler/esbuild's job; `noEmit` anyway).

### vitest.config.ts

```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
```

No `test.pool` key needed — the renamed plugin is a plain Vite plugin (docs verified; the old pool-workers `pool: "..."` config is gone). The plugin reads `main` from the wrangler config; `configPath` stays at repo root, exactly as docs show. `miniflare: {...}` and `main` are available as overrides but unneeded in Phase 1.

### src/index.ts (skeleton — envelope, switch router, getRuntimeInfo seam)

```ts
export interface Env {
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  AGENT_MAX_ITERATIONS?: string;
  SANDBOX_TIMEOUT_MS?: string;
}

const COMPATIBILITY_DATE = "2026-09-01";
const INSTANCE_ID = crypto.randomUUID(); // per isolate boot; surfaces restarts (Pitfall 15)

type ErrorCode = "bad_request" | "not_found" | "not_implemented" | "internal_error";

type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: ErrorCode; message: string; detail?: unknown } };

function json(body: Envelope, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fail(status: number, code: ErrorCode, message: string, detail?: unknown): Response {
  return json({ ok: false, error: detail !== undefined ? { code, message, detail } : { code, message } }, status);
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "bad_request", "request body is not valid JSON");
  }
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string, readonly detail?: unknown) {
    super(message);
  }
}

// Lazy-init seam: Phases 2-3 fill typechecker/sandbox identities; /healthz stays fast.
function getRuntimeInfo() {
  return {
    instanceId: INSTANCE_ID,
    compatibilityDate: COMPATIBILITY_DATE,
    // Only in-band runtime-version signal; exact local-dev value unverified —
    // assert non-empty, decide final source (userAgent vs wrangler-derived) during implementation.
    userAgent: navigator.userAgent,
    typechecker: "unloaded", // Phase 2: pinned typescript version
    sandbox: "unloaded",     // Phase 3: quickjs variant id
  };
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const started = performance.now();
    const { method, pathname } = new URL(request.url);
    const respond = (res: Response, label: string): Response => {
      console.log(`[worker] ${label} -> ${res.status} (${(performance.now() - started).toFixed(1)}ms)`);
      return res;
    };
    try {
      switch (`${method} ${pathname}`) {
        case "GET /healthz":
          return respond(json({ ok: true, data: { status: "ok", runtime: getRuntimeInfo() } }, 200), "GET /healthz");
        case "POST /agent/run":
        case "POST /typecheck":
          return respond(fail(501, "not_implemented", `${method} ${pathname} is registered but not implemented yet`), `${method} ${pathname}`);
        default: {
          if (method === "GET" && pathname.startsWith("/agent/run/")) {
            const id = pathname.slice("/agent/run/".length);
            return respond(fail(404, "not_found", `run ${id} not found`, { id, hint: "isolate may have restarted; in-memory store is best-effort" }), `${method} ${pathname}`);
          }
          return respond(fail(404, "not_found", `no route for ${method} ${pathname}`), `${method} ${pathname}`);
        }
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : "internal_error";
      const message = err instanceof Error ? err.message : String(err);
      const detail = err instanceof HttpError ? err.detail : { instanceId: INSTANCE_ID };
      console.error(`[worker] ${method} ${pathname} failed:`, err);
      return respond(json({ ok: false, error: detail !== undefined ? { code, message, detail } : { code, message } }, status), `${method} ${pathname}`);
    }
  },
} satisfies ExportedHandler<Env>;
```

### src/runs.ts (seam for ROADMAP SC4 — registry + status enum, ~15 lines)

```ts
export type RunStatus = "running" | "success" | "max_iterations" | "deadline" | "llm_error";

export interface RunRecord {
  id: string;
  status: RunStatus;
  createdAt: string;
}

const runs = new Map<string, RunRecord>();

export const runRegistry = {
  create(): RunRecord {
    const run: RunRecord = { id: crypto.randomUUID(), status: "running", createdAt: new Date().toISOString() };
    runs.set(run.id, run);
    return run;
  },
  get(id: string): RunRecord | undefined {
    return runs.get(id);
  },
};
```

`GET /agent/run/:id` for an unknown-but-valid id returns the structured 404 from `src/index.ts` — the honest Phase 1 behavior; the map is filled by later phases.

### test/healthz.spec.ts (workerd smoke — integration style)

```ts
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /healthz", () => {
  it("returns the ok envelope with runtime identity", async () => {
    const res = await exports.default.fetch("http://example.com/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { status: string; runtime: Record<string, unknown> } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
    expect(body.data.runtime.compatibilityDate).toBe("2026-09-01");
    expect(body.data.runtime.typechecker).toBe("unloaded");
    expect(body.data.runtime.sandbox).toBe("unloaded");
    expect(typeof body.data.runtime.instanceId).toBe("string");
  });
});

describe("structured errors", () => {
  it("404 envelope for unknown route", async () => {
    const res = await exports.default.fetch("http://example.com/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("not_found");
  });

  it("404 envelope for unknown run id (registered route, unknown resource)", async () => {
    const res = await exports.default.fetch("http://example.com/agent/run/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("501 envelope for registered-but-unimplemented POST routes", async () => {
    const res = await exports.default.fetch("http://example.com/typecheck", { method: "POST" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("not_implemented");
  });
});
```

(The unknown-route case is 404, not 400 — 400 is reserved for malformed request bodies on implemented POST routes, which arrive in Phase 2/4 via `parseJsonBody()`.) For envelope unit tests, the docs' unit pattern is: `import worker from "../src"` + `createExecutionContext()`/`waitOnExecutionContext()` from `cloudflare:test` + `env` from `cloudflare:workers`, calling `worker.fetch(request, env, ctx)` directly.

### .dev.vars.example (committed; real `.dev.vars` gitignored)

```bash
# Copy to .dev.vars — loaded automatically by `wrangler dev`. All vars are already
# declared (optional) in Env so later-phase plumbing never changes shape.

# LLM provider (Phase 4). Absent/unset => deterministic mock, zero API keys.
LLM_PROVIDER=mock
# LLM_BASE_URL=https://api.openai.com/v1
# LLM_API_KEY=sk-...
# LLM_MODEL=gpt-4o-mini

# Agent loop guardrails (Phase 4)
AGENT_MAX_ITERATIONS=5

# Sandbox deadline per guest execution, ms (Phase 3)
SANDBOX_TIMEOUT_MS=1500
```

`.gitignore` must include: `node_modules/`, `.dev.vars`, `.wrangler/`, `dist-bundle/`.

## Gotchas

1. **nodejs_compat is default-ON at our compatibility date — the scaffold must opt OUT explicitly.** Official docs (updated 2026-08-12): for compatibility dates ≥ `2026-08-04`, `nodejs_compat` + `nodejs_compat_v2` are enabled by default; `2026-09-01` is past the line. Without `"compatibility_flags": ["no_nodejs_compat", "no_nodejs_compat_v2"]`, the isolate gets a `process` global and typescript@6's `isNodeLikeSystem()` would initialize its Node `sys` in Phase 2 — silently defeating the STACK.md design. This corrects the STACK.md config comment; it is the one non-obvious config decision in this phase. (STACK.md's later claim that "no `process` global" exists is only true WITH these flags.)
2. **Install `@cloudflare/vitest-plugin`, never `@cloudflare/vitest-pool-workers`.** The old name is deprecated on npm ("will not receive future updates"). Plugin peer range is `^4.1.0 || ^5.0.0`; pin vitest exactly `4.1.11` — vitest 5.0.3 also satisfies peers but docs/examples target 4.1.x, and the plugin requires ≥ 4.1 regardless.
3. **Plugin prerequisites (docs, 2026-10-08):** compatibility_date ≥ `2022-10-31` and ES-modules-format worker (`export default { fetch }`; a service-worker `addEventListener("fetch")` worker is unsupported). Both satisfied by this scaffold.
4. **Integration tests run the worker in the same Vite module context as the tests** (`exports.default.fetch()` per docs). Module-scope worker state (`INSTANCE_ID`, the run registry Map) is shared across tests in a run, and Vite's module resolution differs subtly from production wrangler bundling. Fine for Phase 1; if it ever matters, the escape hatch is an auxiliary worker (`miniflare.workers` in the plugin options) with documented limitations.
5. **Types wiring differs from the docs' flow — deliberately.** Docs assume `wrangler types` → `worker-configuration.d.ts` + a tests-scoped tsconfig. Verified alternative: `@cloudflare/workers-types` itself declares `Cloudflare.Env` and the `cloudflare:workers` module; `@cloudflare/vitest-plugin/types` contributes only `cloudflare:test`. One root tsconfig with both entries in `types` covers src + test + vitest.config.ts. (The docs' `env` export on `cloudflare:test` is marked deprecated in favor of `env` from `cloudflare:workers`.)
6. **`/healthz` "workerd version" has no official in-isolate API.** `navigator.userAgent` is the only in-band signal, and its exact local-dev value is unverified. ROADMAP SC1 asks for runtime identity; treat userAgent as best-effort, assert it's a non-empty string in tests, and let implementation decide between reporting it and a wrangler-derived constant (`wrangler@4.149.0` → workerd `1.20261006.1`, from the dependency manifest — accurate but drifts on wrangler upgrades unless generated).
7. **Bundle gate is account-free and flag-stricter:** `wrangler deploy --dry-run --outdir dist-bundle` builds locally without uploading. With nodejs_compat disabled, unresolved `node:` imports fail bundling outright — a cleaner Phase 1 gate than relying on unenv-stub detection.
8. **`wrangler dev` defaults to port 8787**, binds local workerd via Miniflare with `TZ=UTC`, loads `.dev.vars` automatically, and does NOT enforce CPU/memory/size limits locally (production-limits docs; `--max-time` on documented curl commands still recommended so a future hung sandbox can't wedge the demo).
9. **400 is pre-wired, not yet exercised:** Phase 1 has no implemented POST body route, so `parseJsonBody()` (400 `bad_request` on malformed JSON) ships as the shared helper the Phase 2/4 routes will use; Phase 1 tests cover 404 (unknown route, unknown run id) and 501 (registered route, unimplemented) instead.
10. **`crypto.randomUUID()` and `performance.now()` are built-in workerd globals** — run ids and the timing foundation (dual-clock strategy lands in Phase 2) need no polyfills and no Node APIs.

## Sources

| Source | Confidence | Notes |
|---|---|---|
| npm registry (verified 2026-10-10 via `npm view`) | HIGH | wrangler@4.149.0 (+workerd 1.20261006.1, esbuild 0.28.2 in deps); @cloudflare/workers-types@5.20261010.1; typescript dist-tags (latest 7.0.2 native; 6.0.3 tarball URL confirmed; 5.9.3 present); vitest@5.0.3 / 4.1.11; @cloudflare/vitest-plugin@1.4.0 peers `^4.1.0 \|\| ^5.0.0`; @cloudflare/vitest-pool-workers deprecation notice verbatim |
| Tarball inspection: @cloudflare/vitest-plugin@1.4.0 | HIGH | `dist/pool/index.d.mts`: exports `cloudflareTest` (+`cloudflarePool`, …); options schema = `main?`, `wrangler.{configPath?, environment?}`, `miniflare.workers?`; `types/cloudflare-test.d.ts`: `cloudflare:test` provides `env` (deprecated → `cloudflare:workers`), `SELF`, `createExecutionContext`, `waitOnExecutionContext`, DO/queue/D1 helpers |
| Tarball inspection: @cloudflare/workers-types@5.20261010.1 | HIGH | `index.d.ts` L16382 `declare namespace Cloudflare { interface Env {} }`; L16687 `declare module "cloudflare:workers"` (via `CloudflareWorkersModule`) — grounds the no-`wrangler types` tsconfig flow |
| Cloudflare docs — Write your first test / Workers Vitest integration (updated 2026-10-08) | HIGH | `cloudflareTest({wrangler:{configPath}})` exact form; prereqs compat-date ≥ 2022-10-31 + ESM format + vitest ≥ 4.1; unit pattern (import worker + `createExecutionContext`) vs integration pattern (`exports.default.fetch()`); same-context caveat + auxiliary-worker note; types via `@cloudflare/vitest-plugin/types` |
| Cloudflare docs — Node.js compatibility (updated 2026-08-12) | HIGH | nodejs_compat + v2 default-ON at compatibility date ≥ 2026-08-04; complete opt-out = `no_nodejs_compat` + `no_nodejs_compat_v2`; unenv polyfill `[unenv] … not implemented` behavior; `node:vm` stub gating — grounds the flags decision and the stricter bundle gate |
| wrangler@4.149.0 `config-schema.json` (unpkg) | HIGH | Minimal fields `name`/`main`/`compatibility_date`/`compatibility_flags` all top-level; `observability` = `{enabled, head_sampling_rate, redact_query_string, issues}` — grounds wrangler.jsonc |
| Cloudflare docs — Local development / Limits (via project STACK.md, re-cited) | HIGH | `wrangler dev` = real workerd via Miniflare, no account/login; limits (CPU/size) not enforced locally; `TZ=UTC` |
| Flagged as unverified | MEDIUM | Exact content of `navigator.userAgent` under local workerd (Gotcha 6); `.dev.vars` auto-load is long-documented wrangler behavior (HIGH) but re-assert via the Phase 1 smoke test if a var must be present at boot |
