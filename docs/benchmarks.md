# Benchmark: native tsc-rs vs the in-isolate checker

Reproduce with `npm run bench:tsc-rs` — it boots its own `wrangler dev`, prints this
table, and rewrites this file. README.md commits the same numbers.

Generated: 2026-10-13T11:29:02.632Z

| snippet          | tsc-rs cold ms | tsc-rs warm med(10) | tsc-rs warm min | in-isolate cold ms | in-isolate warm med(5) | errors (exp/got) |
|------------------|----------------|---------------------|-----------------|--------------------|------------------------|------------------|
| slugify-iter1    | 77.9 | 31.5 | 29.3 | 237.0 | 8.0 | 2/2 |
| slugify-final    | 37.2 | 32.3 | 30.0 | 6.0 | 9.0 | 0/0 |
| fibonacci-final  | 35.0 | 33.1 | 30.6 | 16.0 | 5.0 | 0/0 |
| lib-heavy        | 38.2 | 31.1 | 28.6 | 34.0 | 13.0 | 0/0 |
| synthetic-100    | 52.0 | 31.6 | 29.8 | 24.0 | 14.0 | 0/0 |

tsc-rs native spawn+init: 2.5 ms median across the 5 API instances (not part of the cold column).
Machine: linux arm64, v24.19.0, tsc-rs 0.2.0 (native), workerd via wrangler dev, typescript 6.0.3 in-isolate.

Footnotes:
- tsc-rs warm med(10) = median of 10 subsequent createProgram+diagnostics checks on the SAME API instance (persistent native subprocess, sync-RPC); cold = the first such check after spawn.
- In-isolate cold = POST /typecheck data.coldMs (run 1 of 6); warm med(5) = median of runs 2-6 (runs: 6 so there are 5 warm samples; the endpoint default of 5 yields only 4).
- Lib-closure difference, footnoted rather than forced to parity: tsc-rs checks against its default lib.es2022.full chain INCLUDING DOM; the in-isolate checker uses the bundled 115-file es2022 core closure (no DOM). All five snippets type-check identically on both.
- Both legs share the guest surface: /guest-globals.d.ts (repo GUEST_GLOBALS_TEXT) is an explicit rootName on the tsc-rs leg and prepended implicitly by the in-isolate checker; options mirror GUEST_COMPILER_OPTIONS (strict, ES2022, noEmit, ESNext modules, Bundler resolution, skipLibCheck, isolatedModules, forceConsistentCasingInFileNames).
- tsc-rs is host-side only here (native binary subprocess, never bundleable into workerd). The Typechecker interface (src/typecheck/index.ts) stays the drop-in seam for a future WASM build.
