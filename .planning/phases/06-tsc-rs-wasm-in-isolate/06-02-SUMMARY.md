# 06-02 Summary: TSCHECKER wiring + healthz identity flip + bench third leg + wasm live harness + README honesty + full gates in BOTH modes

**Status:** COMPLETE (all 4 tasks delivered; 1 real behavioral fix within task intent; 3 plan-internal grep miscounts documented)

**Executed:** 2026-10-13 | **Plan:** 06-02 rev 1 | **Executor:** gsd-executor

## Per-task notes

### T1 — Route wiring + identity (`src/index.ts`) — DONE (commit `a2530ba`)
- All 8 verbatim edits applied exactly: Env `TSCHECKER?` field (+ comment), `handleTypecheck(request, env)`, `getTypechecker(env)` at the three call sites (/typecheck, agent loop, shell), route case passes `env`, `getTypecheckerIdentity(env)` in getRuntimeInfo, handleShell doc comment updated.
- `npm run check` exit 0. **Deviation (plan-internal miscount, no code deviation):** `grep -c "getTypechecker(env)"` = **4**, not 3 — the plan's own mandatory (1h) edit rewrites the handleShell doc comment to contain `getTypechecker(env)`, which the plain grep also counts (call sites: index.ts:159/254/306 + comment :290). Same class as 06-01's documented `TscRsWasmTypechecker` miscount. All other greps exact: `getTypechecker()`=0, `getTypecheckerIdentity(env)`=1, `TSCHECKER`=2, `handleTypecheck(request, env)`=1, `handleTypecheck`=2, `TSCHECKER?: string`=1.

### T2 — Live wasm-mode harness + `test:live` wiring — DONE (commit `caaa68a`)
- `scripts/test-typecheck-wasm-live.mjs` written verbatim; `package.json` test:live chain extended with the 5th leg. All 11 harness greps match the plan exactly (TSCHECKER=4, --var=3, flip string=2, 2322=6, "unloaded"=3, SLUGIFY_ITER1=2, SLUG_TASK=2, shellCheck(=3, 30s timeout=1, teardown=2, package.json=1).
- **Environment note (no file change):** bare `node scripts/test-typecheck-wasm-live.mjs` dies with `spawn wrangler ENOENT` — `wrangler` resolves only via `node_modules/.bin` (the npm-script PATH; the pre-existing harnesses have the same property and say so in their headers). All runs used `PATH="$PWD/node_modules/.bin:$PATH"`, the exact environment `npm run test:live` provides.
- **REAL fix within task intent — `src/typecheck-wasm/checker.ts` tsconfig lib pin:** the first live run failed 8/21 asserts: the module's embedded default lib chain includes DOM (`var console: Console`), which TS2403-clashed with the seeded `guest-globals.d.ts` console declaration — every guest carried an extra error diag, so RED/iter1 exactness, lib-sanity, final-clean and the 3-iteration agent-loop gates all failed. Root-caused on the 06-01 spike probe worker (`/tmp/tsrust-spike/probe`, booted with the repo's wrangler + PID/port discipline): adding `"lib":["es2022"]` to the seeded tsconfig yields exactly the ts-js surface — RED → single TS2322 1:7, slugify-iter1 → exactly 2 diags first at 2:9, lib-heavy → clean. This mirrors the plan's own bench-footnote text ("strict + es2022 tsconfig under /app, **mirroring the ts-js guest surface**"). One-line TSCONFIG_TEXT change + comment; committed with T2. After the fix: **21 ok / 0 FAIL, exit 0**, including `teardown: wrangler killed and port closed`.

### T3 — Bench third leg + REAL run + README honesty — DONE (commit `146611b`)
- `scripts/bench-tsc-rs.mjs`: all 7 verbatim edits (var-capable spawnWrangler, leg renumbering, leg 3/3 block, widened table, machine line, 3 footnotes, doc title/intro). All script greps exact (leg 3/3=2, spawnWrangler=3, --var=2, TSCHECKER literal=1, killWrangler wasm=1, runs: 6=6, wasm warm med(5)=2, 569df52=2).
- **Bench ran FOR REAL** (3h): exit 0, 30 snippet assertions (15 ts-js + 15 wasm) + 2 teardowns ok, `docs/benchmarks.md` regenerated. README re-pasted from the run output between the markers; re-run after the README rewrite still exits 0 (acceptance).
- README honesty: Type-checker / Drop-in seam / In-isolate rows, bench prose, honest reading, Commands (test:live 5-harness wording, TWO-workers bench bullet, new TSCHECKER bullet), healthz row — all verbatim; `no WASM build exists yet` = 0.
- **Deviation (plan-internal miscount, no content deviation):** acceptance expects `grep -c "wasm warm med(5)" README.md` = 1; actual **2** — the plan's own (3k) mandate to paste "the full footnote list" necessarily includes the wasm footnote that carries the same string (pasted header + pasted footnote). Verbatim content stands.

### T4 — Full gate chain in BOTH TSCHECKER modes — DONE (verification only, no commit, no file changes)
| Gate | Result |
|---|---|
| `npm run check` | exit 0 (CHECK-GREEN) |
| `npx vitest run` | **Test Files 7 passed (7) / Tests 57 passed (57)** |
| `npm run gate:no-host-eval` | pass (EVAL-GATE-GREEN) |
| `npm run bundle:check` | pass; `dist-bundle/` has exactly **2 .wasm** (quickjs 503,134 B + ts_rust 5,125,434 B); Total Upload 16,889.25 KiB / gzip 4,187.62 KiB |
| `npm run bench:tsc-rs` | exit 0 (BENCH-GREEN), 37 ok lines, legs 1/3 + 2/3 + 3/3 |
| `npm run test:live` | exit 0 (LIVE-GREEN): **210 ok / 0 FAIL** across the 5 harnesses; **7** teardown lines = 1(typecheck)+1(sandbox)+3(agent A/B/C)+1(shell)+1(wasm); `ts-rust@569df52 (wasm)` ×1 (wasm flip); `typescript@6.0.3 (in-isolate)` ×1 (ts-js flip label) |

Both modes by construction: the four default-mode harnesses boot var-less (ts-js; preflight `unloaded` + identity flip asserted) and the fifth boots `--var TSCHECKER:tsc-rs-wasm` (unloaded preflight, fixture exactness, flip).

## Wasm bench numbers (real run, committed to docs/benchmarks.md + README)

| snippet | tsc-rs cold | warm med(10) | warm min | ts-js cold | ts-js warm med(5) | wasm cold | wasm warm med(5) | errors |
|---|---|---|---|---|---|---|---|---|
| slugify-iter1 | 41.3 | 30.2 | 28.9 | 236.0 | 8.0 | 543.0 | 177.0 | 2/2 |
| slugify-final | 33.5 | 30.3 | 29.6 | 7.0 | 5.0 | 159.0 | 148.0 | 0/0 |
| fibonacci-final | 39.8 | 30.2 | 28.1 | 11.0 | 5.0 | 160.0 | 145.0 | 0/0 |
| lib-heavy | 33.2 | 31.7 | 30.0 | 30.0 | 12.0 | 148.0 | 145.0 | 0/0 |
| synthetic-100 | 31.8 | 29.7 | 28.8 | 19.0 | 12.0 | 162.0 | 147.0 | 0/0 |

Spawn line: 2.6 ms median; Machine: linux arm64, v24.19.0, tsc-rs 0.2.0 (native), workerd via wrangler dev, typescript 6.0.3 in-isolate (ts-js), ts-rust wasm pin 569df52 in-isolate (TSCHECKER=tsc-rs-wasm). Warm wasm checks ≈145–177 ms vs ts-js 5–12 ms vs native ~30 ms.

## Files + commits
| Commit | Files |
|---|---|
| `a2530ba` | `src/index.ts` (TSCHECKER Env field, env through handleTypecheck + 3 getTypechecker call sites, identity reflects selection) |
| `caaa68a` | `scripts/test-typecheck-wasm-live.mjs` (new), `package.json` (5-leg test:live), `src/typecheck-wasm/checker.ts` (`lib: ["es2022"]` pin — the T2 live-run fix) |
| `146611b` | `scripts/bench-tsc-rs.mjs` (third leg), `docs/benchmarks.md` (real 3-leg run), `README.md` (honesty correction + real table + commands) |

Nothing pushed; `.planning/` not committed.

## Deviations from plan (complete list)
1. **T2 checker.ts fix (behavioral, 1 line + comment):** wasm tsconfig gained `"lib":["es2022"]` — required to satisfy the plan's own harness gates (TS2322 exactness, clean fixtures, 3-iteration loop). Proven on the spike probe before editing; mirrors the plan's own "mirroring the ts-js guest surface" footnote language. Files_modified list did not name checker.ts; "fix the causing file (never the gate)" applied.
2. **T1 acceptance miscount:** `getTypechecker(env)` grep = 4 (not 3) — the plan's own (1h) comment edit creates the 4th match. Code follows verbatim content.
3. **T3 acceptance miscount:** `wasm warm med(5)` in README = 2 (not 1) — the (3k) "full footnote list" paste necessarily includes the wasm footnote carrying the string. Content follows verbatim blocks.
4. **Harness invocation:** verify command `node scripts/test-typecheck-wasm-live.mjs` needs `node_modules/.bin` on PATH (npm-script environment); bare invocation ENOENTs on `spawn wrangler` — same as the four pre-existing harnesses. No file change.
5. **Working tree after T4:** `docs/benchmarks.md` is left regenerated by the T4 gate-chain bench run (timings differ run-to-run by design; the bench rewrites the file on every invocation). README commits the T3 (3h) run's numbers per plan. T4 commits nothing, so the regenerated docs remain uncommitted; rerun `npm run bench:tsc-rs` anytime to regenerate.

## Scratch/process notes
- Live-harness discipline held throughout: free ports, detached process groups, kill by PID (`process.kill(-pid)`) + fuser backstop, ports verified freed; no `pkill -f wrangler` anywhere. Probe debugging used `/tmp/tsrust-spike/probe` (booted via repo wrangler, PID `/tmp/wasm-gates/probe-wrangler.pid`, port freed after).
- `/tmp/opencode` is not writable in this environment (owned by another user); scratch moved to `/tmp/wasm-gates`.
