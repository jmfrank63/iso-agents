# Technology Stack
**Project:** iso-agents | **Researched:** 2026-10-10

## Recommended Stack

### Core Framework (Worker runtime & tooling)

| Technology | Version | Purpose | Why |
|---|---|---|---|
| wrangler | 4.149.0 | Local dev server, bundling, config | Current major (verified). `wrangler dev` runs the **real production runtime locally**: it boots Miniflare, which executes your Worker in a local `workerd` binary (wrangler 4.149.0 bundles workerd 1.20261006.1 + esbuild 0.28.2, verified via its dependency manifest). This satisfies "prototype lives inside workerd, no Cloudflare account" exactly — local dev requires no login. HIGH |
| workerd (via wrangler dev) | 1.20261006.1 | The runtime itself | Same V8-based isolate runtime Cloudflare runs in production. Local dev runs it with `TZ=UTC`, matching production semantics. HIGH |
| compatibility_date | `"2026-09-01"` | Locks runtime behavior | Docs say "set to today's date"; a pinned recent date is deterministic. `2026-09-01` is safely at/below the bundled workerd's date (1.20261006.1), so `wrangler dev` accepts it. HIGH |
| @cloudflare/workers-types | 5.20261010.1 | Runtime API types (Request, Response, Fetcher…) | Latest (verified). Alternative flow: `wrangler types` generates a `worker-configuration.d.ts` (the flow the current vitest-plugin docs assume). Either works; use workers-types in tsconfig `types` for a simple pure-tsc setup, or the generated file if you want the `Env` type from wrangler config. HIGH |
| TypeScript (host-side tooling) | 6.0.3 | Authoring/type-checking the worker source itself | Same package as in-isolate checking — one dependency, two roles. HIGH |
| HTTP layer: plain `fetch` handler + URL routing | — | The 4 endpoints (`POST /agent/run`, `GET /agent/run/:id`, `POST /typecheck`, `GET /healthz`) | Zero dependencies. A `switch` on `new URL(request.url).pathname` + method is fully sufficient for 4 routes and matches "minimal deps". HIGH (design opinion) |

**Config (wrangler.jsonc):**

```jsonc
{
  "name": "iso-agents",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  // Deliberately NO nodejs_compat: with no `process` global, typescript@6's
  // isNodeLikeSystem() guard is false and its Node "sys" layer never initializes
  // (verified in source + spike). We supply our own in-memory CompilerHost.
  "rules": [{ "type": "Text", "globs": ["**/*.d.ts"] }] // to import lib.*.d.ts as strings for the in-isolate checker
}
```

**tsconfig.json (worker code):** `target ES2022`, `module ES2022`, `moduleResolution "bundler"`, `strict true`, `noEmit true`, `skipLibCheck true`, `types: ["@cloudflare/workers-types"]`. HIGH (standard workers setup).

### Sandbox Execution

| Technology | Version | Purpose | Why |
|---|---|---|---|
| quickjs-emscripten-core | 0.32.0 | Sandbox API (`newQuickJSWASMModuleFromVariant`, contexts, `evalCode`) | Pure-JS core package — the JS API layer over the QuickJS C API (verified; no WASM inside it). HIGH |
| @jitl/quickjs-singlefile-browser-release-sync | 0.32.0 | The QuickJS-WASM build itself | **Pick this variant.** WASM is base64-embedded in a single ESM file (verified: "WASM data embedded into a browser ESModule", ~3.1MB unpacked) → no `.wasm` file resolution at runtime, which is the one thing workerd bundling makes awkward. Its exports map resolves via unconditional `.`/`import`/`default` entries, so wrangler/esbuild bundles it without needing the `browser` condition. **sync** (not asyncify) because our sandbox runs pure-CPU spec-assertion code with no async host calls — asyncify costs 2x size and ~40% speed (per official docs) for nothing we need. Uses `runtime.setInterruptHandler()` for runaway loops. HIGH on variant choice; MEDIUM that exact bundling needs one build-spike confirmation (variants declare a first-party `workerd` export condition, so workerd is an explicitly supported target). |

QuickJS-in-Workers is an established pattern; workerd forbids `eval`/`new Function`, so a WASM interpreter is the only way to execute LLM-generated JS safely inside the isolate, and quickjs-emscripten is the maintained, documented option (QuickJS vendored at 2025-09-13, per docs).

### Type-Checking (in-isolate)

| Technology | Version | Purpose | Why |
|---|---|---|---|
| typescript (pure-JS line) | **6.0.3** | `createProgram` + custom in-memory `CompilerHost`, diagnostics, `transpileModule` (TS→JS) | **The critical finding:** npm `latest` = 7.0.2, but **typescript@7.x is the Go-based native compiler (tsgo)** — verified by packing the tarball: 2.5MB stub whose dependencies are native platform binaries (`@typescript/typescript-linux-x64`, etc.). It cannot run in-process inside workerd. The pure-JS line is **6.0.3** (latest 6.x, verified: `bin/tsc` is a Node JS script, `lib/typescript.js` is 8.8MB UMD, **zero** native deps, exports `createProgram`/`createIncrementalProgram`/`transpileModule`/`CompilerHost`). 5.9.3 is the fallback if any 6.x API mismatch appears. HIGH |
| In-memory CompilerHost | — | `getSourceFile`/`readFile`/`fileExists` read from the project's in-memory VFS; `writeFile` is a no-op; no fs anywhere | `transpileModule` never touches the filesystem. For `createProgram`, `isNodeLikeSystem()` (`typeof process !== "undefined" && …`) evaluates false in workerd without `nodejs_compat`, so typescript's Node-backed `sys` is never initialized and cannot throw at import. HIGH |
| lib .d.ts files for the guest | from typescript@6.0.3 | Provide `lib.es2022.d.ts` etc. as text inside the virtual FS | Without them every program errors "Cannot find global type 'Array'" (hit in the spike with `lib: []`). Import them as text via the wrangler `Text` rule and register them as source files. HIGH (mechanism); exact lib set = implementation choice. |
| tsc-rs (seam only — do NOT use now) | 0.2.0 | Future faster checker | Rust port of TS7 (pingdotgg/ts-rs). Ships **native binaries only** (linux-x64, linux-arm64, darwin-arm64; **no WASM build**) → unusable inside workerd today. Keep the type-checker behind one module boundary (`typecheck.ts`) so a WASM tsc-rs can drop in later. HIGH |

**Bundle/limits reality check:** the whole `lib/typescript.js` esbuild-bundles to ~10MB ESM (verified in spike). Worker size limit is **64 MiB uncompressed** on all plans with no gzip limit (docs, updated 2026-10-08) — so even a deployed worker fits TS + QuickJS comfortably; `wrangler dev` local doesn't enforce size at all. Watch **128 MB isolate memory** (TS is memory-hungry; keep guest programs small) — risk-flagged, not blocking for a prototype. HIGH on limits; MEDIUM on memory headroom. Note: free-plan CPU limit is 10 ms/request in production, but local `wrangler dev` does not enforce it (MEDIUM), so `POST /typecheck` latency measurement works locally.

### LLM Access

| Technology | Version | Purpose | Why |
|---|---|---|---|
| Raw `fetch` + hand-rolled `LlmProvider` interface | — (zero deps) | Pluggable provider seam: `complete(messages): Promise<{text, usage}>` | **Use this, not the AI SDK.** The prototype needs exactly two implementations: (1) a deterministic mock that emits code from the spec without any I/O — the zero-key default; (2) an OpenAI-compatible chat-completions call, which is a single `fetch` POST to `${LLM_BASE_URL}/chat/completions` with bearer auth. ~40 lines total, no dependency risk, trivially mockable in tests. Env opt-in: `LLM_PROVIDER=mock|openai`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`. HIGH (design opinion, grounded in the "zero API keys / minimal deps" constraints) |
| `ai` + `@ai-sdk/openai-compatible` (alternative, not installed by default) | 7.0.137 / 3.0.67 | If richer streaming/tool-calls are needed later | Both exist and are worker-compatible; verified versions. Overkill for one POST endpoint + a mock. MEDIUM-HIGH |

### Testing

| Technology | Version | Purpose | Why |
|---|---|---|---|
| vitest | 4.1.11 | Test runner | Docs and plugin peer-range align on vitest ≥4.1 (plugin peers: `^4.1.0 \|\| ^5.0.0`); 4.1.11 is the latest 4.x (verified). HIGH |
| @cloudflare/vitest-plugin | 1.4.0 | Runs tests **inside workerd** | **Renamed package alert:** `@cloudflare/vitest-pool-workers` is deprecated ("renamed to @cloudflare/vitest-plugin… will not receive future updates" — verified on npm). Current API (docs updated 2026-10-08): `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })` in `vitest.config.ts`; tests get `cloudflare:test` (`createExecutionContext`, `waitOnExecutionContext`) and `cloudflare:workers` (`exports` for integration tests). Requires compatibility_date ≥ 2022-10-31 and ESM-format worker — both satisfied. HIGH |

```ts
// vitest.config.ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
```

### Supporting Libraries

| Technology | Version | Purpose | Why |
|---|---|---|---|
| (none) | — | Run state, request validation, IDs | In-memory `Map<runId, RunRecord>` for `GET /agent/run/:id` (in-memory state constraint; survives per dev session, that's fine for a prototype). Hand-validate the two JSON bodies (each has ~4 fields). `crypto.randomUUID()` is built into workerd for run IDs. Every dependency avoided is startup time and surface area saved. HIGH (design opinion) |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|---|---|---|---|
| Type-checking | typescript@6.0.3 (pure JS) | typescript@7.0.2 (npm `latest`) | **7.x is the Go-native tsgo** — packed & inspected: 2.5MB stub with `@typescript/typescript-*-x64` native binary deps. Cannot execute inside workerd. HIGH |
| Type-checking (future) | typescript@6.0.3 now; seam for later | tsc-rs@0.2.0 | Native binaries only (linux-x64/arm64/darwin-arm64), no WASM build → impossible in isolate today. Revisit when upstream ships WASM. HIGH |
| Type-checking | typescript@6.0.3 | typescript@5.9.3 | 5.9.3 also works (pure JS), but 6.0.3 is the maintained end of the JS line and API-identical for our use; only fall back if a 6.x regression appears. HIGH |
| Sandbox | singlefile-browser release-sync variant | wasmfile variants (`@jitl/quickjs-wasmfile-*`) | Wasmfile variants need a separate `.wasm` file resolved at runtime — awkward under wrangler bundling; singlefile embeds it. (They do declare `workerd` export conditions, so they're the fallback if singlefile misbehaves.) MEDIUM-HIGH |
| Sandbox | sync variant | asyncify variants (`*-asyncify`) | Asyncify exists only to let sandboxed code call **async** host functions synchronously; our guest code is pure computation + spec assertions. Docs: 2x size, ~40% speed. Paying that for nothing. HIGH |
| Sandbox | quickjs (bellard) variants | quickjs-ng variants (`@jitl/quickjs-ng-*`) | ng is a faster fork, but the default quickjs library is the documented default path; identical JS API makes it a drop-in swap later if perf demands. MEDIUM |
| Sandbox | quickjs-emscripten | isolated-vm / `node:vm` / `Function` | All impossible: workerd forbids dynamic eval, and isolated-vm is a native Node addon — neither runs in workerd. This is exactly why the WASM interpreter is required. HIGH |
| Transpile | `ts.transpileModule` (already bundled) | esbuild-wasm | Adds a second ~10MB WASM toolchain and its own async init for a job transpileModule already does in-process with the package we ship anyway. HIGH |
| LLM access | raw fetch + provider interface | Vercel AI SDK (`ai@7.0.137`) | The AI SDK is worker-compatible but pulls a dependency tree for one chat-completions POST; the mock provider doesn't fit its abstractions anyway. Revisit only if streaming/tools become requirements. MEDIUM-HIGH |
| Router | plain URL matching | Hono | Hono is excellent, but for 4 static routes a 15-line switch beats a framework dependency; `wrangler dev` + tests don't care. Revisit at >~10 routes. HIGH (design opinion) |
| Testing | @cloudflare/vitest-plugin@1.4.0 | @cloudflare/vitest-pool-workers | Renamed/deprecated — npm deprecation notice says it will not receive future updates. HIGH |
| State | in-memory `Map` | KV / Durable Objects | Both need a Cloudflare account/binding config; the prototype is local-only with in-memory state by constraint. HIGH |
| Dev harness | `wrangler dev` | @cloudflare/vite-plugin | Vite plugin is also Miniflare/workerd under the hood and nice for apps with frontends; the brief specifies `wrangler dev`, and it's the leaner path for an API-only worker. MEDIUM |

## Installation

```bash
# runtime deps — bundled INTO the worker
npm i typescript@6.0.3 \
      quickjs-emscripten-core@0.32.0 \
      @jitl/quickjs-singlefile-browser-release-sync@0.32.0

# dev tooling
npm i -D wrangler@4.149.0 \
         @cloudflare/workers-types@5.20261010.1 \
         vitest@4.1.11 \
         @cloudflare/vitest-plugin@1.4.0

# run
npx wrangler dev        # local workerd, no Cloudflare account needed
npx vitest run          # tests execute inside workerd
```

(Exact pins as researched; loosen to carets at your own risk — note vitest@5 also satisfies the plugin's peer range but 4.1.x matches the current docs.)

## Sources

| Source | Confidence | Notes |
|---|---|---|
| npm registry (verified 2026-10-10 via `npm view`) | HIGH | wrangler@4.149.0 (+ its bundled workerd@1.20261006.1, esbuild@0.28.2 from deps manifest); @cloudflare/workers-types@5.20261010.1; typescript dist-tags (latest 7.0.2, 6.x line ends at 6.0.3, 5.x at 5.9.3); quickjs-emscripten-core@0.32.0 and all @jitl/quickjs-* variants; ai@7.0.137; @ai-sdk/openai-compatible@3.0.67; vitest@5.0.3 / 4.1.11; @cloudflare/vitest-plugin@1.4.0 (peers vitest ^4.1.0 \|\| ^5.0.0); @cloudflare/vitest-pool-workers deprecation notice; tsc-rs@0.2.0 (native-only per its platform-binary deps) |
| Tarball inspections (`npm pack` + unpack) | HIGH | typescript@7.0.2: `bin/tsc` launcher + 20 native `@typescript/typescript-*` deps (2.5MB) → tsgo native, NOT pure JS. typescript@6.0.3: `bin/tsc` is a Node JS script, `lib/typescript.js` 8.8MB UMD, zero native deps, `createProgram`/`transpileModule`/`CompilerHost` present in `lib/typescript.d.ts` |
| Source inspection of typescript@6.0.3 `lib/typescript.js` | HIGH | `sys = isNodeLikeSystem() ? getNodeSystem() : undefined`; guard is `typeof process !== "undefined" && !!process.nextTick && …` → with no `process` global, Node sys never initializes (import is side-effect-safe for workerd) |
| Bundling + execution spike (esbuild → ESM, `--platform=browser`, `--define:process=undefined` to simulate workerd-without-nodejs_compat) | HIGH (bundling & API execution) / MEDIUM (transfers to workerd) | typescript@6.0.3 bundles to a 9.98MB ESM file that imports cleanly with zero Node builtins; `transpileModule` output correct; `createProgram` with a pure in-memory host ran (diagnostics were only missing-lib errors, as expected with `lib: []`). **Not yet executed inside real workerd — first build task must confirm**, including lib.d.ts-via-Text-rules |
| Cloudflare docs — Local development (updated 2026-08-20) | HIGH | `wrangler dev` runs Worker code locally on Miniflare/workerd by default; `--remote` is legacy; local dev needs no account |
| Cloudflare docs — Limits (updated 2026-10-08) | HIGH | Worker size 64 MiB uncompressed, all plans, "no compressed size limit"; 128 MB isolate memory; free-plan CPU 10 ms/request (prod), paid default 30 s |
| Cloudflare docs — Workers Vitest integration, "Write your first test" (updated 2026-10-08) | HIGH | `@cloudflare/vitest-plugin` + `cloudflareTest()` API, vitest ≥4.1, compatibility_date ≥ 2022-10-31, `cloudflare:test` / `cloudflare:workers` modules |
| quickjs-emscripten docs (GitHub, quickjs-emscripten-core README, v0.32.0) | HIGH | Variant system; every variant family ships a `workerd` export condition; singlefile-browser = "WASM data embedded into a browser ESModule"; asyncify = 2x size / 40% speed, "only adopt if you need it"; QuickJS vendored 2025-09-13 |
| Local-dev non-enforcement of CPU/size limits; wrangler `alias` config field as shim fallback | MEDIUM | Expected Miniflare behavior and a not-verified-today wrangler config option; neither is load-bearing for the primary recommendation |
