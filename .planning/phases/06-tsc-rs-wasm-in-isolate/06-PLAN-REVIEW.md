# Plan Review: Phase 6

**Verdict:** REVISE

Plans 06-01/06-02 are architecturally sound and faithful to 06-CONTEXT's locked decisions and
the 06-RESEARCH spike facts. The verbatim shim/checker/harness code traces clean against the
ground truth (`/tmp/tsrust-spike/ts-rust/npm/wasm/core.js`, the probe artifact, and the live
transcripts), and the spike artifact itself verifies byte-exact (5,125,434 bytes, sha256
`6e71a7b8…c1362eb3`). What blocks execution is traceability of the requirement IDs and a set
of mis-hand-traced grep gates — 12 wrong expected counts across both plans — several of which
would send the executor "fixing the causing file" to chase phantom failures per the plans' own
gate rule.

## Checks

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1 | Coverage + CONTEXT decisions | **FAIL** | WASM-01..05 each delivered and in frontmatter (06-01: 01–03; 06-02: 02–05), but the IDs are defined **nowhere** (REQUIREMENTS.md has no v3 block; ROADMAP/PROJECT: 0 hits; Traceability table has no Phase 6 rows) and REQUIREMENTS.md "Out of Scope" still asserts "tsc-rs inside the worker runtime … no WASM" — false under the binding premise correction. CONTEXT decisions otherwise respected: TSCHECKER default `ts-js`; fresh `WebAssembly.Instance` per check; identity `ts-rust@569df52 (wasm)`; unconditional ship; "unpublished; built from source at pin 569df52" wording; stack depth documented-not-solved. |
| 2 | Shim fidelity vs core.js | **PASS** | Verified against actual artifact introspection: 23 imports (ts_host.fs/fs_take + 21 wasi) all covered by construction (imports-driven loop → table entry or ENOSYS 52 stub); exports match `TsRustExports` and `assertModuleShape` exactly. fs-bridge protocol (-1 / -2-len / staged bytes), op codes, stat `f|d|o <size> <ns>` and readdir `f<name>\0` formats, NUL-join `[cwd, flags, ...args]` protocol, flags bits, `WasiExit` on proc_exit, ENOSYS/EBADF values — line-for-line with core.js. No `node:`/`worker_threads`. Two safe, documented deviations (defensive `fs_take` guard; `Date.now` fallback in `wallNow`). |
| 3 | Checker semantics | **PASS** | `/app` seed + tsconfig byte-identical to probe `clean.json`; `GUEST_GLOBALS_TEXT` seeded (TS2593 lesson); mapping is 1-based with `/app` strip, `(program)`/-1/-1 for config diags, `byLocation` sort mirroring `src/typecheck/index.ts`; fixture parity (TS2322 @1:7 from probe startPosition {0,6}; 2:9 slugify) matches the probe transcript and existing harnesses; fresh instance + `performance.now()` timings. |
| 4 | Executability | **FAIL** | Verbatim blocks complete (extracted and re-grepped); boot/teardown discipline mirrors the proven detached-process-group + port-backstop pattern; `--var` injection matches test-agent-live precedent; bench leg 3 reuses hoisted helpers correctly; bundle math sane (2 .wasm siblings, ~+5.1 MB, 64 MiB headroom). But 12 grep gates across the two plans print numbers other than the stated expectations (issues 1–6). |
| 5 | Frontmatter / files_modified / waves | **PASS** | Both frontmatters well-formed; `files_modified` complete per task (verified task-by-task); waves 1→2 with `depends_on: ["06-01"]` sane; `wrangler.jsonc` untouched is correct (Text rule has `fallthrough: true`; default CompiledWasm rule covers `**/*.wasm` per the quickjs precedent + `src/sandbox/wasm.d.ts` ambient types). |

## Issues (blocking)

1. **06-02 T1 — `grep -c "getTypechecker()" src/index.ts` expects 0, will print 1.** The
   handleShell doc comment at `src/index.ts:286` reads `// (getTypechecker() singleton,
   getSandboxRuntime(env), transpileGuest), so` and survives the three call-site edits.
   **Fix:** add a fourth edit to T1 updating that comment to
   `// (getTypechecker(env) singleton, getSandboxRuntime(env), transpileGuest), so` (keeps the
   gate at 0 and the comment truthful) — or change the expected count to 1.

2. **06-01 T1 — two `docs/ts-rust-wasm.md` greps mis-traced.** `grep -c "CI=1 bash
   scripts/wasm/build.sh"` expects 1 but the planned doc contains 2 (Provenance "Build" row +
   rebuild step 4); `grep -c "wasm32-wasip1"` expects 2 but the doc contains 3 (the intro
   paragraph adds one). **Fix:** update the two expectations to 2 and 3 (the doc content is
   correct as written), or dedupe the intro/step wording.

3. **06-01 T2 — `mapping.ts` `/app/` counts mis-traced.** The comment line `// form
   ("/app/guest.ts" -> "/guest.ts") …` contains `/app/`, so `grep -o "/app/" | wc -l` prints 3
   (expected 2) and `grep -c "/app/"` prints 2 (expected 1). **Fix:** update both expectations
   to 3 and 2, or reword that comment to avoid the literal (e.g. `("/app/…")`).

4. **06-01 T3 — four `shim.ts` counts mis-traced.** Measured against the planned verbatim
   content: `new WebAssembly.Instance` = 2 not 1 (prepareRun header comment + the instantiation
   site); `ts_host` = 6 not 5 (the "Decode one ts_host.fs op" comment is missed); `proc_exit`
   = 3 not 2 (the WasiExit class comment is missed); `clock_time_get` = 2 not 1 (the wallNow
   comment is missed). **Fix:** update the four expected counts to 2 / 6 / 3 / 2 (the ENOSYS,
   WasiExit, `^import`, prepareRun, runTsc, TS_RUST_PIN, poll_oneoff counts all verify correct
   as stated).

5. **06-02 T2 — three harness counts mis-traced.** `grep -c "ts-rust@569df52 (wasm)"` = 2 not
   1 (the flip assert is multi-line: comparison line + label line — the plan's "one line
   carries both" premise is false); `grep -c "2322"` = 6 not 3 (each of the three asserts
   spans two matching lines: code line + "TS2322" label line); `grep -c -e "--var"` = 3 not 2
   (TWO header comment lines carry it — lines 4 and 6 — plus the varFlags array). **Fix:**
   update the three expectations to 2 / 6 / 3 (the TSCHECKER=4, "unloaded"=3, SLUGIFY_ITER1=2,
   SLUG_TASK=2, shellCheck(=3, AbortSignal=1, teardown=2 counts verify correct).

6. **06-02 T4 — the live-log identity grep expects 3; a green run prints 1.**
   `grep -c "typescript@6.0.3 (in-isolate)" /tmp/wasm-gate-live.log` — harnesses print only
   `ok - <label>` lines: the typecheck harness has exactly ONE label containing the string
   (its preflight asserts `"unloaded"`, not the identity — the plan's "asserts it twice"
   rationale is false), and the shell harness's label ("flips: typechecker identity flipped
   …") does NOT contain the string. Following the plan's own "fix the causing file, never the
   gate" rule, the executor would hunt a phantom regression. **Fix:** expect 1 with corrected
   rationale (typecheck-harness flip label only) — or make the shell harness's flip label
   carry the identity string and expect 2.

7. **WASM-01..05 have no canonical definitions; REQUIREMENTS.md now contradicts the phase.**
   The IDs appear only in the two plans (frontmatter + prose); REQUIREMENTS.md has v1 and
   "Milestone v2 Requirements" blocks but no v3 block, its Traceability table has no Phase 6
   rows, and its Out-of-Scope table still says "tsc-rs inside the worker runtime | Native
   binaries only today (no WASM); documented seam instead" — false per the binding premise
   correction in 06-CONTEXT. /gsd-verify-work will have no requirements to validate against.
   **Fix:** before/with 06-01 execution, add a "Milestone v3 Requirements (defined
   2026-10-13)" block to `.planning/REQUIREMENTS.md` defining WASM-01..05 to match the plans
   (01 vendored artifact + provenance; 02 wasm checker with ts-js-identical fixture parity;
   03 TSCHECKER selection + healthz identity; 04 bench third leg + README/docs honesty; 05
   unit/live/gate coverage in both modes), add Phase 6 Traceability rows, and correct the
   Out-of-Scope row ("unpublished; built from source at pin 569df52 — shipped in-isolate").
   Add `.planning/REQUIREMENTS.md` to 06-01's `files_modified` (or record it as a planning-doc
   step executed before wave 1).

## Suggestions (non-blocking)

- The 06-02 T2 agent-loop leg is the first end-to-end run of the mock over the wasm checker
  (3-iteration convergence, iter1 2:9). Realistic given the probe transcripts and upstream's
  14/14 tsc-parity suite — but if tsc 7.1.0-dev's embedded lib surfaces any extra diagnostic
  on mock iter2, the harness fails honestly. Remember this when triaging a red run.
- The shim's two deviations from core.js (defensive `fs_take` no-op guard, `Date.now` fallback
  in `wallNow`) are safe and documented in-code; no fidelity action needed.
- 06-01 T1 correctly plans for `/tmp/tsrust-spike` vanishing (rebuild + sha256 update
  discipline); the artifact verified byte-exact today, so the primary path is live.
- 06-02 T4's "total upload ≈ 16.9 MB" is an estimate; consider deriving the number from the
  actual `bundle:check` size output when that gate runs (the 64 MiB headroom is not in
  question).
- README "Replace EXACTLY" blocks match the current file's visible content, but several carry
  trailing-whitespace table padding that the executor's edit tooling must match byte-for-byte;
  if an edit misses, re-copy the row from the live file rather than the plan.
