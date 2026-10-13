# 05-02 Summary: Agent shell runtime — POST /agent/shell + live harness + full gates

**Status:** DELIVERED (all 4 tasks, full gate chain green, 3 commits)
**Executed:** 2026-10-13
**Plan:** 05-02 rev 1 (executed verbatim; one plan-internal grep miscount noted as deviation 1)

## Per-task notes

### T1 — Pure shell session module (`src/shell/shell.ts`) — DONE
- Created verbatim from the plan (all load-bearing comments included as planned content): `runShellSession` over a per-request Map VFS, six ops (`ls`/`cat`/`write`/`rm`/`typecheck`/`run`), `MAX_SHELL_COMMANDS = 32`, `MAX_SHELL_VFS_BYTES = 1048576`, `ShellBadRequestError` for request-shape violations only, per-op failures as `ok:false` entries, `stopOnError` → `haltedAt`.
- Exactly 3 `import type` lines, zero runtime imports (vitest-safety pattern of `src/agent/loop.ts`).
- All verify greps exact: import type 3 / imports 3 / `case "` 6 / unknown_op 1 / commands cap 1 / vfs cap 1 / haltedAt 5 / `eval(` 0; plus acceptance extras: not_found 3 / vfs_full 2 / "empty" 1 / transpile_error 1 / `new Function` 0. `npm run check` clean.

### T2 — Route wiring (`src/index.ts`) + pure spec (`test/shell-pure.spec.ts`) — DONE
- Four exact edits to `src/index.ts`: shell import, `handleShell` before the lazy-init seam comment, `"/agent/shell": "POST"` in KNOWN_PATHS, `POST /agent/shell` route case. Handler wires the SAME per-request primitives as `/agent/run` (`getTypechecker()`, `getSandboxRuntime(env)`, `transpileGuest`) — agent loop and runRegistry untouched.
- `test/shell-pure.spec.ts` created verbatim: 14 stub-seam tests.
- `npm run check` clean; `npx vitest run` = **5 files / 41 tests** (27 existing + 14 new), exactly as planned.
- Verify greps: KNOWN_PATHS entry 1, handleShell 2, runShellSession 2, agent/shell 2, `it(` 14, rejects.toBeInstanceOf 4, MAX_SHELL_VFS_BYTES 5 — all exact. `ShellBadRequestError` in src/index.ts counts **3** lines, not the plan's 2 (see deviation 1). `gate:no-host-eval` pass.

### T3 — Live shell harness + `test:live` wiring — DONE
- `scripts/test-shell-live.mjs` created verbatim (PID-file-free variant of the proven pattern: free port, detached process group, port-closed teardown backstop; never pkill). `package.json` `test:live` now chains 4 harnesses.
- Standalone run: **exit 0, 54 ok lines (53 asserts + teardown), zero FAIL**. All legs green in order: preflight unloaded ×2 → 405 → 10×400 validation → op-level 200s (unknown_op continues, not_found with available list, empty, vfs_full no-mutation) → happy session 8/8 → VFS isolation → error session (TS2322 at 2:9, run still 2/2 — types erased) → logic-broken ITER2 (typecheck ok, run 1/2) → stopOnError halt (haltedAt=1, run never executed) → while(true) structured timeout ≤ deadline+250ms, worker survived → upsert ×3 → identity flips LAST (typescript@6.0.3 in-isolate; sandbox non-unloaded) → teardown ok.
- Verify greps all exact: test-shell-live in package.json 1; expect400 11; SLUGIFY_ITER1 3; SLUGIFY_ITER2 2; haltedAt 4; 2250 1; typescript@6.0.3 (in-isolate) 1; "unloaded" 4; unknown_op 2.
- Environment note: bare `node scripts/test-shell-live.mjs` fails with `spawn wrangler ENOENT` in this shell (wrangler resolves only via `node_modules/.bin` on PATH, as npm scripts provide — all four harnesses share the identical `spawn("wrangler", ...)` pattern). Run via `npm run test:live` or with PATH augmented; harness content unchanged.

### T4 — Full gate chain — DONE (six exit codes 0, no file changes)
- `npm run check` → CHECK-GREEN
- `npx vitest run` → Test Files 5 passed (5) / Tests 41 passed (41)
- `npm run gate:no-host-eval` → EVAL-GATE-GREEN (shell adds no eval path)
- `npm run bundle:check` → BUNDLE-GREEN; deployable `dist-bundle/index.js` contains zero `tsc-rs` (0 occurrences, 0 import statements — the 05-01 bundle-hygiene substance holds; see deviation 2 for the literal `grep -rl` form)
- `npm run bench:tsc-rs` → BENCH-GREEN (05-01 deliverable unaffected)
- `npm run test:live` → LIVE-GREEN; log `/tmp/shell-gate-live.log`: **0 FAIL lines, 189 total ok lines, exactly 6 teardown lines (1+1+3+1)**. Per-harness ok counts: typecheck 41, sandbox 40, agent 54 (wranglers A/B/C = 45+4+5), shell 54.
- Post-chain hygiene: generated `docs/benchmarks.md` (bench gate rewrites it) restored to HEAD per 05-01 precedent; confirmed zero leftover wrangler/workerd processes from this execution (the Oct-12 wranglers on ports 8799/8842/8843 with PPID 95832 predate this run and were left alone — no pkill used).
- `git diff --stat` across the 3 commits = exactly the plan's five `files_modified` (statelessness spot-check holds; runRegistry/agent loop untouched).

## Files + commits
- `f166856` feat(05-02): pure shell session module — `src/shell/shell.ts`
- `ba38f89` feat(05-02): POST /agent/shell route + shell-pure spec — `src/index.ts`, `test/shell-pure.spec.ts`
- `4b29a41` feat(05-02): live shell harness as 4th test:live leg — `scripts/test-shell-live.mjs`, `package.json`
- `.planning/` not committed; nothing pushed.

## Shell happy-session behavior observed (live, in workerd)
One POST /agent/shell with `write → typecheck → run → cat → ls → rm → cat → ls` (8 ops) returned HTTP 200 `{ok:true, data:{results[8]}}`, no `haltedAt`, every op with finite `ms`: write created `/guest.ts` (byte count reported); typecheck ok with 0 diagnostics against the real in-isolate typescript@6.0.3 checker; run transpiled and executed in QuickJS with **2/2 tests passing** (status ok); cat roundtripped the exact source; ls listed the single entry; rm removed it; post-rm cat was `ok:false {code:"not_found"}`; final ls empty. A following separate request saw an empty VFS (per-request isolation). In the error session (mock ITER1 source), the typecheck op failed with exactly 2 diagnostics, first being **TS2322 at line 2, column 9, file `/guest.ts` (1-based)**, while the run op still executed and passed 2/2 — types are erased in the sandbox, proving typecheck-gate and sandbox are independent layers. The while(true) run returned a structured `timeout` ExecuteResult within the 2s deadline + 250ms and the worker kept serving.

## Deviations
1. **Plan acceptance grep `grep -c "ShellBadRequestError" src/index.ts → 2` does not hold: actual 3.** Plan-internal arithmetic slip: the plan's own verbatim `handleShell` comment block ("including the ShellBadRequestError the pure session module throws") is a third matching line alongside the import and the `instanceof` check. Content is EXACTLY the plan's verbatim block (the harder requirement), so no change was made; the substance (import + instanceof present) holds. No other grep in any task deviated.
2. **T4 acceptance `grep -rl "tsc-rs" dist-bundle/ | wc -l → 0` is stale at plan time** — already flagged in 05-01 (bundle sourcemap embeds src comment strings; `dist-bundle/README.md` carries the bench table). The load-bearing substance verified: **0 `tsc-rs` occurrences in the deployable `dist-bundle/index.js`** and 0 tsc-rs import statements in the bundle.
3. **Bare `node scripts/test-shell-live.mjs` requires `node_modules/.bin` on PATH** (or run through npm scripts). Environment resolution detail, identical for all four harnesses; not a code change.

## Gate results
- `npm run check` — green
- `npx vitest run` — 5 files / 41 tests pass
- `npm run gate:no-host-eval` — pass
- `npm run bundle:check` — green; dist-bundle/index.js free of tsc-rs
- `npm run bench:tsc-rs` — exit 0
- `npm run test:live` — exit 0; 4 harnesses green in order (typecheck 41 / sandbox 40 / agent 54 / shell 54 ok lines; 0 FAIL; 6/6 teardowns)
