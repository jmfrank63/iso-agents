# 05-01 Summary: tsc-rs host-side bench + README restructure

**Status:** DELIVERED (both tasks, all gates green, 2 commits)
**Executed:** 2026-10-13

## Per-task notes

### T1 — tsc-rs devDependency + bench harness — DONE
- `package.json`: `tsc-rs@0.2.0` exact-pinned in devDependencies + `bench:tsc-rs` script, exactly per plan edits (1a)/(1b).
- `npm install`: added 2 packages (`tsc-rs@0.2.0` + `@tsc-rs/linux-arm64@0.2.0` optional dep). The allow-scripts warning for tsc-rs' postinstall appeared as predicted (research gotcha 2, benign — bench never uses the bin shim; per plan, tsc-rs NOT added to allowScripts).
- `scripts/bench-tsc-rs.mjs` created verbatim from the plan (comments included as planned content).
- Bench run 1 (T1): exit 0 — 5 tsc-rs-leg assertions + 15 in-isolate-leg assertions + teardown ok; all expected error counts 2/0/0/0/0 asserted on BOTH legs; `docs/benchmarks.md` written.
- Gates: `npm run check` green; `npx vitest run` 4 files / 27 tests; `npm run gate:no-host-eval` pass; `npm run bundle:check` builds (Total Upload 11862.02 KiB / gzip 2034.86 KiB — unchanged from before this plan); `dist-bundle/index.js` (the deployable) contains zero `tsc-rs`; zero tsc-rs imports under `src/`.
- All 15 static acceptance-criteria greps on package.json / package-lock.json / bench script matched the plan's expected counts exactly.

### T2 — README restructure — DONE
- README replaced entirely with the plan template; the BEGIN/END BENCH TABLE block carries the exact table + spawn line + machine line + footnotes emitted by bench run 2 (executed after the rewrite, per plan action). All numbers are bytes from a real run.
- All 16 verify greps matched expected counts exactly (Why-this-exists=1, BEGIN/END=1/1, 5 data rows, Machine: linux=1, Typechecker=3, typescript@6.0.3=1, /agent/shell=2, lands-with-05-02=1, six endpoint rows=6, host-side ci=3, wasm build ci=4, bench:tsc-rs=2).
- Post-rewrite `npm run bench:tsc-rs` exit 0 (bench-green).

## Files + commits
- `663ed87` feat(05-01): tsc-rs@0.2.0 devDependency + host-side bench harness — package.json, package-lock.json, scripts/bench-tsc-rs.mjs, docs/benchmarks.md
- `c1f8dc1` docs(05-01): README restructure — README.md
- `.planning/` not committed; nothing pushed. Working tree clean.

## Measured bench table (committed in README; docs/benchmarks.md holds the T1 run)

| snippet          | tsc-rs cold ms | tsc-rs warm med(10) | tsc-rs warm min | in-isolate cold ms | in-isolate warm med(5) | errors (exp/got) |
|------------------|----------------|---------------------|-----------------|--------------------|------------------------|------------------|
| slugify-iter1    | 40.0 | 33.8 | 31.6 | 242.0 | 8.0 | 2/2 |
| slugify-final    | 36.0 | 32.1 | 29.8 | 6.0 | 5.0 | 0/0 |
| fibonacci-final  | 35.7 | 32.1 | 30.0 | 12.0 | 6.0 | 0/0 |
| lib-heavy        | 36.1 | 31.6 | 30.4 | 35.0 | 13.0 | 0/0 |
| synthetic-100    | 42.2 | 31.6 | 30.6 | 23.0 | 14.0 | 0/0 |

tsc-rs native spawn+init: 2.5 ms median across the 5 API instances.
Machine: linux arm64, v24.19.0, tsc-rs 0.2.0 (native), workerd via wrangler dev, typescript 6.0.3 in-isolate.

Honest reading holds: in-isolate warm (5–14 ms) beats tsc-rs warm (~32–34 ms) on these tiny guests; tsc-rs cold is faster than the in-isolate first-check (except slugify-iter1's 242 ms in-isolate cold, which includes first-use lib parse warm-up on the fresh isolate); tsc-rs's story is the seam, not a wall-ms win here.

## Deviations
1. **Plan verify expectations `grep -rn "tsc-rs" src/ | wc -l → 0` and `grep -rl "tsc-rs" dist-bundle/ | wc -l → 0` do not hold literally** — they were stale at plan time: 4 pre-existing *comment* mentions of "tsc-rs" live in src/typecheck/index.ts (3) and src/index.ts (1), committed in Phase 02 (ec8bcbd), and the bundle sourcemap embeds those comment strings (dist-bundle/index.js.map = 1 file). The load-bearing substance holds and was verified: **zero tsc-rs imports under src/** (`grep -rn "from \"tsc-rs|require(\"tsc-rs|import(\"tsc-rs" src/` = 0) and **zero `tsc-rs` in dist-bundle/index.js** (the deployable). This plan introduced no src/ changes at all. No action taken (plan forbids src/ edits). Note for 05-02: dist-bundle/README.md now carries the README's bench table, so the dist-bundle grep can never literally hit 0 going forward.
2. **docs/benchmarks.md (T1 commit) and the README table (T2 commit) come from different real runs** — inherent to the plan's sequencing (T1 commits docs from its run; T2 re-runs and pastes fresh numbers). Both are real measured output; the post-rewrite verification run leaves docs/benchmarks.md dirty in the worktree by design (generated file), restored to HEAD to keep the tree clean.
3. npm allow-scripts warning on tsc-rs postinstall — expected per plan/research (gotcha 2), benign, no allowScripts entry added.

## Gate results
- `npm install` — ok (2 packages added; benign allow-scripts warning)
- `node -e "console.log(require('tsc-rs').version)"` → `0.2.0`
- `npm run bench:tsc-rs` — exit 0 (×3 runs; 20 leg assertions + teardown each)
- `npm run check` — green
- `npx vitest run` — 4 files / 27 tests pass
- `npm run gate:no-host-eval` — pass
- `npm run bundle:check` — green; `dist-bundle/index.js` free of tsc-rs
- `npm run test:live` — intentionally NOT run (plan: 05-02 gate)
