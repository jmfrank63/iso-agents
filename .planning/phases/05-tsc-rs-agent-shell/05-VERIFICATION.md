# Phase 5 Verification

**Verdict:** DELIVERED
**Verified:** 2026-10-13 (independent re-run; nothing trusted from summaries — every gate re-executed, every shell behavior re-driven over HTTP from a fresh own-PID boot)

## Requirements table

| Req | Claim | Verdict | Evidence (re-run) |
|-----|-------|---------|-------------------|
| TSCRS-01 | `npm run bench:tsc-rs` runs native tsc-rs on ≥5 guests vs in-isolate checker; table printed + committed to README | ✅ PASS | Exit 0 on my run: 5 tsc-rs-leg + 15 in-isolate-leg assertions + teardown ok, all error counts 2/0/0/0/0 asserted on BOTH legs; table + spawn + machine lines printed (below); README.md:34–43 carries a real measured table |
| TSCRS-02 | tsc-rs is devDep exact-pinned; never imported in src/; never bundled | ✅ PASS | `package.json:19` `"tsc-rs": "0.2.0"` (devDependencies, exact); lockfile resolves tsc-rs 0.2.0 + 3 platform optionals; `require("tsc-rs").version` → `0.2.0`; `grep -rn "from \"tsc-rs\|require(\"tsc-rs\|import(\"tsc-rs" src/` → 0 (4 pre-existing comment mentions from Phase 02, ec8bcbd — not imports); freshly rebuilt `dist-bundle/index.js` → 0 `tsc-rs` occurrences |
| SHELL-01 | POST /agent/shell scripted session: write → typecheck → run → cat/ls/rm, one stateless HTTP call | ✅ PASS | Happy session re-driven live (see spot-check log): 6/8-op variants all correct incl. cat exact-content roundtrip, ls byte counts, rm + post-rm not_found; 4th live harness leg green (54 ok lines) |
| SHELL-02 | Guardrails inherited: sandbox deadline + typecheck gate semantics; no host eval; per-request VFS | ✅ PASS | while(true) → structured `timeout` in 762 ms (≤ 2s deadline + 250ms), worker kept serving; typecheck op returns ok:false diagnostics WITHOUT blocking run (default stopOnError=false); `gate:no-host-eval` green AND fresh bundle grep → 0 eval/`new Function`; VFS isolation re-proven (new request → empty ls) |
| SHELL-03 | (Plan-internal: shell harness as 4th `test:live` leg) | ✅ PASS | `package.json:9` chains 4 harnesses; my full `npm run test:live` exit 0: **189 ok / 0 FAIL / 6 teardown lines (1+1+3+1)** |

## Success criteria table (ROADMAP Phase 5)

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 1 | `npm run bench:tsc-rs` — native binary on ≥5 snippets, printed table, results committed to README | ✅ PASS | 5 locked snippets (slugify-iter1/final, fibonacci-final, lib-heavy, synthetic-100); my re-run table below is same order of magnitude as the committed README table (tsc-rs cold 31–59 ms vs 36–42; warm med ~29–36 vs ~32–34; in-isolate cold 6–221 vs 6–242; warm med 5–13 vs 5–14) — honest provenance, numbers vary run-to-run as expected |
| 2 | README "Why" documents the video mapping: tsc-rs native host-side today, Typechecker = drop-in seam when WASM lands | ✅ PASS | README.md:8–21: where-things-run table ("**Host-side today**… Native binaries cannot execute inside workerd and no WASM build exists yet"), seam row naming `Typechecker` interface + `TranspileOnlyTypechecker` precedent; honest-reading paragraph (README.md:54–57) + 5 footnotes incl. the lib-closure (DOM vs core) difference — honesty survives scrutiny |
| 3 | POST /agent/shell executes scripted session: write → typecheck (diagnostics on error) → run (sandbox) → cat/ls/rm roundtrip, one call | ✅ PASS | Re-driven live: write→typecheck(0 diagnostics)→run(2/2 in QuickJS)→cat(exact bytes)→ls→rm in ONE POST; error session: exactly 2 diagnostics, first TS2322 at line 2 column 9 file `/guest.ts` (1-based), while the run op still executed and passed 2/2 — types are erased in the sandbox |
| 4 | Shell ops guardrailed: run/typecheck inherit sandbox deadline + typecheck gate; no host eval; per-request VFS | ✅ PASS | src/index.ts:300–303 wires the SAME per-request primitives as /agent/run (`getTypechecker()`, `getSandboxRuntime(env)`, `transpileGuest`); guardrails live inside the injected runtime (src/shell/shell.ts:8–15, inherited by construction); while(true) bounded (762 ms) with worker survival; per-request VFS isolation asserted live; ITER2 logic-broken run completes with tests 1/2 (failing tests are feedback, op stays ok); stopOnError halts at the failed typecheck (haltedAt=1, run never executed); 400 on request-shape violations (missing commands, cat without file) |
| 5 | Full gate chain green: check / 27+ vitest / no-host-eval / bundle floor / 4 live harnesses | ✅ PASS | check: green · vitest: **5 files / 41 tests passed** · gate:no-host-eval: green · bundle:check: green (11868.62 KiB / gzip 2036.21; deployable free of tsc-rs and eval) · test:live: exit 0, **189 ok / 0 FAIL / 6 teardowns** across 6 wrangler boots |

## Live spot-check log (condensed — own boot, free port, 30 asserts)

- Boot: `/healthz` 200 with full runtime identity (workerd, compat date, typechecker/sandbox, agent, instanceId).
- Happy session (6 ops): write `/guest.ts` byte-exact · typecheck ok 0 diagnostics · run sandbox status ok **2/2 tests** · cat roundtrips exact source · ls 1 entry · rm removed.
- Error session (mock ITER1): typecheck op ok:false with exactly **2 diagnostics, TS2322 @ 2:9 `/guest.ts`**; run op still executed → **2/2 passed** (types erased — typecheck gate and sandbox are independent layers).
- ITER2 (type-fixed, logic-broken): typecheck **passes** (0 diagnostics); run completes ok with **1/2** tests passing — failing tests surface as feedback, never dropped.
- while(true): structured `timeout` ExecuteResult, op ms **762 ≤ 2250** (2s deadline + 250ms); a follow-up session answered — wrangler never hung.
- stopOnError: `haltedAt: 1`, results length 2 — the run op never executed.
- 400s: missing commands → bad_request; `cat` without args → bad_request.
- Phase 1–4 regression block: `/agent/run` mock → **success with 3 iterations** (broken-first loop demonstrably iterates to green) with timings; `GET /agent/run/:id` replays the stored run byte-consistent; unknown id → honest 404; `/typecheck` runs:5 → stats with medianMs; `/sandbox/execute` → structured ExecuteResult (`status:ok`, `tests[0].passed:true`, structured console logs `{level:"log",args:["hi"]}`); GET on POST-only routes → 405 with `allow: POST`; unknown path → 404.
- Note: two early FAILs during spot-checks were verifier-script bugs (reading `.ok` off my own stripped response object; string-matching structured log objects), corrected in the verifier — the returned payloads proved correct project behavior both times. Zero project defects surfaced.

## Bench table from my run (re-executed 2026-10-13)

| snippet          | tsc-rs cold ms | tsc-rs warm med(10) | tsc-rs warm min | in-isolate cold ms | in-isolate warm med(5) | errors (exp/got) |
|------------------|----------------|---------------------|-----------------|--------------------|------------------------|------------------|
| slugify-iter1    | 59.4 | 32.4 | 28.1 | 221.0 | 7.0 | 2/2 |
| slugify-final    | 38.3 | 36.3 | 31.8 | 6.0 | 5.0 | 0/0 |
| fibonacci-final  | 37.1 | 29.8 | 27.6 | 11.0 | 5.0 | 0/0 |
| lib-heavy        | 31.1 | 30.5 | 28.5 | 32.0 | 12.0 | 0/0 |
| synthetic-100    | 32.2 | 29.4 | 28.2 | 21.0 | 13.0 | 0/0 |

tsc-rs native spawn+init: 2.4 ms median across the 5 API instances (not part of the cold column).
Machine: linux arm64, v24.19.0, tsc-rs 0.2.0 (native), workerd via wrangler dev, typescript 6.0.3 in-isolate.

Consistent with the README-committed run (same order of magnitude, same qualitative story: in-isolate warm 5–13 ms beats tsc-rs warm ~29–36 ms on tiny guests; tsc-rs cold beats the first in-isolate check except where lib-parse warm-up dominates; spawn+init ~2.5 ms).

## Milestone v2 DoD

Phase 5 is v2's only phase; its 5 SCs are the milestone deliverable. **Milestone v2 goal achieved:** native tsc-rs is benched host-side against the in-isolate checker on 5 identical guests with a committed honest table, and the isolate is agent-drivable over HTTP via the stateless `/agent/shell` tool protocol with Phase 2/3 guardrails inherited by construction. v1's core loop remains green end-to-end (regression block passed).

## Gaps

1. **REQUIREMENTS.md is stale for v2** — its v2 section still reads "Deferred to future release… Tracked but not in current roadmap" and carries no TSCRS-01/02 or SHELL-01..03 entries; the requirements live only in ROADMAP.md's v2 section (pre-existing, flagged as acceptable in 05-PLAN-REVIEW). Bookkeeping gap, not a delivery gap.
2. **README vs docs/benchmarks.md numbers come from different real runs** (inherent to the 05-01 plan sequencing; both honest, generated file restored to HEAD post-verification).
3. **Stray pre-existing wrangler/workerd processes** on ports 8799 (a /tmp/qjs-spike wrangler) and 8842/8843 (iso-agents) predate this verification and Phase 5 execution; none belong to this run's boots (all 6 teardowns verified). Left untouched — not this phase's defect, out of verifier scope.
4. Cosmetic: per-harness ok-line attribution in my log parse (40/40/55/54) differs from the 05-02 summary's (41/40/54/54) by line-boundary counting; totals match exactly (189) and both runs are exit 0 / 0 FAIL / 6 teardowns.

Nothing blocking. Phase 5 and milestone v2 stand as DELIVERED.
