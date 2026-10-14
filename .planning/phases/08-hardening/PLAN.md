# Milestone v5: Hardening — GPT-6.1-Sol review remediation

**Source:** external code review by GPT-6.1-Sol (2026-10-14, delegated subagent; all findings
live-reproduced in workerd by the reviewer). Review preserved at
`.planning/reviews/2026-10-14-gpt61sol.md`. Verdict: no CRITICAL; 8 MAJOR; 3 MINOR.

## Tasks (each = reviewer finding + prescribed fix + regression proof)

<task type="auto">
  <name>H1: wasm checker must check every submitted file</name>
  <fix>checker.ts: replace `include: ["*.ts"]` with an explicit `files` list = every submitted
  source + trusted globals; validate extensions (.ts/.d.ts only).</fix>
  <regression>dir/guest.ts with `const x: number = "bad"` → ok:false TS2322.</regression>
</task>
<task type="auto">
  <name>H2: guest paths cannot collide with compiler-owned files</name>
  <fix>Namespace separation: guest files may not be named tsconfig.json / guest-globals.d.ts /
  any seeded path (reject 400 after canonicalization); compiler config stays host-controlled.</fix>
  <regression>posting tsconfig.json {noCheck:true} → 400 bad_request, not a clean verdict.</regression>
</task>
<task type="auto">
  <name>H3: held-fs sync ordered + fully inside recycle</name>
  <fix>shim.ts: remove obsolete paths BEFORE writing replacements; wrap sync + input prep +
  ts_run + result decode in one try/catch that drops held state on any exception.</fix>
  <regression>check dir-file then dir/guest.ts → second check succeeds (was mkdir 500, same gen).</regression>
</task>
<task type="auto">
  <name>H4: run deadline bounds every stage and retry</name>
  <fix>loop.ts: single deadline captured at run start; check remaining time after each awaited
  stage and before returning success; provider retries inherit remaining budget (no fresh
  timeout per attempt); terminal status run_deadline when exceeded.</fix>
  <regression>tiny budget + slow provider stub → run_deadline, never success-after-deadline.</regression>
</task>
<task type="auto">
  <name>H5: guests cannot fabricate test evidence</name>
  <fix>harness.ts: keep test records in a closure private to the harness (not a writable guest
  global); host reads results via a retained private handle; harness functions resist replacement.</fix>
  <regression>guest that clears/inserts into the old global yields 0 fabricated passes.</regression>
</task>
<task type="auto">
  <name>H6: type-aware assertions</name>
  <fix>toBeCloseTo validates finite number + tolerance; toEqual uses structural equality without
  JSON-stringify equality pitfalls (NaN never equals anything; undefined !== fn).</fix>
  <regression>expect(NaN).toBeCloseTo(42) fails; expect(NaN).toEqual(null) fails.</regression>
</task>
<task type="auto">
  <name>H7: finalize survives FIFO eviction</name>
  <fix>runs.ts: finalize operates on the caller-held record reference; eviction of an active
  record blocked (or finalize updates the object regardless of registry membership).</fix>
  <regression>evict-then-finalize unit test leaves no record stuck in running.</regression>
</task>
<task type="auto">
  <name>H8: unexpected failures finalize the run</name>
  <fix>index.ts /agent/run: wrap dependency construction + loop in try/catch → finalize with
  terminal internal-error status (llm_error family or new `internal_error`), keep partial
  transcript, then return 500 envelope.</fix>
  <regression>checker-trap request leaves a finishedAt record, not running.</regression>
</task>
<task type="auto">
  <name>H9: JSON-safe sandbox values</name>
  <fix>runtime.ts: one jsonSafe() policy applied to result + console args (BigInt → string,
  circular → "[circular]", etc.) before accounting/return.</fix>
  <regression>execute(1n) → 200 with stringified result; console.log(1n) captured.</regression>
</task>
<task type="auto">
  <name>H10: console cap bounds retained bytes</name>
  <fix>cap checks remaining capacity per entry; truncate oversized args; never retain full dumps.</fix>
  <regression>console.log("x".repeat(1e6)) → retained entry ≤ cap.</regression>
</task>
<task type="auto">
  <name>H11: execution failures surface in feedback</name>
  <fix>loop.ts: when execution status !== ok and no tests ran, feedback includes status + error
  first; "no test() calls found" only when execution completed cleanly.</fix>
  <regression>timeout guest feedback contains "timeout", not only missing-tests text.</regression>
</task>

## Verification
`npm run check` · vitest (64 + new regressions) · `gate:no-host-eval` · `bundle:check` ·
`test:live` (5 harnesses) · wasm-mode boots: all Sol repros re-run and green (fixer appends
repro results to 07-reviews file appendix).
