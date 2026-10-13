# Phase 6 Verification

**Verdict:** DELIVERED

**Verified:** 2026-10-13 (goal-backward, objective re-run — no summary trusted; every gate and
live check below was executed fresh by the verifier in this session)

## Requirements table

| Req | Verdict | Evidence (re-verified, not trusted) |
|-----|---------|-------------------------------------|
| WASM-01 | PASS | `sha256sum src/typecheck-wasm/ts_rust.wasm` → `6e71a7b82eff24106fe065358b48708875fc4598921727b5d6f55813c1362eb3`, 5,125,434 bytes — byte-exact vs plan record (commit `0f697bb`). `docs/ts-rust-wasm.md`: pin `569df525d3adfe55d31f1b027569a51953707480`, toolchain (rustc/cargo 1.99.0, wasm32-wasip1, binaryen wasm-opt 132), 6-step rebuild-from-source (~6.5 min), npm status "**Unpublished; built from source at pin 569df52**". `package.json` + `scripts/copy-quickjs-wasm.mjs` grep for rustup/cargo/wasm-opt/ts-rust → 0 hits: `npm install` needs no toolchain, no repo build step. |
| WASM-02 | PASS | Live wasm mode (my boots, `--var TSCHECKER:tsc-rs-wasm`): RED guest → exactly 1 diag, TS2322 at `/guest.ts` 1:7; slugify-iter1 → exactly 2 diags, first TS2322 at 2:9; slugify-final → 0 diags; lib-heavy guest clean on the module's embedded lib closure. Exactness proven via `/agent/shell` typecheck op, verdict level via `/typecheck` (harness ok-lines + capstone). Mapping (src/typecheck-wasm/mapping.ts): 1-based line/col, `/app/` stripped, config diags → `(program)` -1/-1, `byLocation` sort, ok iff no Error category. |
| WASM-03 | PASS | `selection.ts` `parseTSChecker`: default `ts-js`, `tsc-rs-wasm`, throws on unknown (unit spec `test/typecheck-selection.spec.ts:24`). Factory `getTypechecker(env)`/`getTypecheckerIdentity(env)` at all three call sites — src/index.ts:159 (/typecheck), :254 (agent loop), :306 (shell). Default mode unchanged: var-less boot flips to `typescript@6.0.3 (in-isolate)` (test:live leg 1 ok-line). Wasm mode: `unloaded` preflight → `ts-rust@569df52 (wasm)` after first check (test:live leg 5 + my capstone boot, both observed). |
| WASM-04 | PASS | Bench third leg ran FOR REAL — verifier's own run exit 0 (37 ok / 0 FAIL, legs 1/3+2/3+3/3, both wrangler teardowns ok); committed run at HEAD `docs/benchmarks.md` (Generated 2026-10-13T15:36:39Z, commit `146611b`) carries the wasm column with real numbers. README marker-bounded table matches the committed run; machine line names `ts-rust wasm pin 569df52 in-isolate (TSCHECKER=tsc-rs-wasm)`. Honesty: README where-things-run row + bench footnote both say "unpublished; built from source at pin 569df52"; stale claim `no WASM build exists yet` → 0 hits in README. |
| WASM-05 | PASS | Unit specs: 7 files / 57 tests, all pass (41 baseline + 11 mapping/memfs + 5 selection; wasm/typescript graphs never dragged into vitest transport — memfs 0 imports, mapping type-only import, selection 0 imports). 5th live harness: exactly 21 ok / 0 FAIL incl. clean teardown. Full gate chain green in BOTH modes (legs 1–4 boot var-less ts-js with `unloaded` preflights + flip asserts; leg 5 + bench leg 3 boot `--var TSCHECKER:tsc-rs-wasm`). |

## Both-mode gate table

| Gate | Result (verifier run) |
|------|----------------------|
| `npm run check` | exit 0 |
| `npx vitest run` | **Test Files 7 passed (7) / Tests 57 passed (57)** |
| `npm run gate:no-host-eval` | pass (exit 0; no `eval(`/`new Function(` in src/) |
| `npm run bundle:check` | pass; Total Upload **16,889.25 KiB / gzip 4,187.62 KiB**; `dist-bundle/` has exactly **2 .wasm**: quickjs 503,134 B + ts_rust 5,125,434 B |
| `npm run test:live` | exit 0; **210 ok / 0 FAIL**; 7 teardown ok-lines (1 typecheck + 1 sandbox + 3 agent + 1 shell + 1 wasm); flips observed: `typescript@6.0.3 (in-isolate)` ×1 (ts-js leg), `ts-rust@569df52 (wasm)` ×1 (wasm leg) |
| `npm run bench:tsc-rs` (wasm-mode addendum) | exit 0; **37 ok / 0 FAIL**; leg 1/3 native + leg 2/3 ts-js boot + leg 3/3 wasm boot; 2 teardown ok-lines; `docs/benchmarks.md` regenerated |

Both modes by construction: the four default harnesses boot var-less (ts-js), the fifth harness
and bench leg 3 boot `--var TSCHECKER:tsc-rs-wasm`; each asserts the `unloaded` preflight and the
identity flip of the SELECTED checker.

## Capstone live log (condensed)

Verifier's own PID-file boot (`setsid`, detached process group, free port,
`--var TSCHECKER:tsc-rs-wasm`, PID `/tmp/verify06/capstone-wrangler.pid`):

1. `GET /healthz` (before any check) → `runtime.typechecker === "unloaded"` ✓
2. `POST /agent/run` `{task: "Implement a slugify function", spec: …}` → HTTP 200,
   `status: "success"`, **exactly 3 iterations**, `timings.typecheckMs: 952` (>0),
   `timings.totalMs: 1051`; `iterations[0].typecheck.ok === false` with
   `TS2322 "Type 'string' is not assignable to type 'number'."` at `/guest.ts` **2:9**
   (Error category); final iteration's guest.ts is the clean slugify; final sandbox status `ok`.
   (End-to-end mock loop gated by the wasm checker — CORE-03 intact.)
3. `GET /healthz` (after) → `runtime.typechecker === "ts-rust@569df52 (wasm)"` ✓ (identity flip)
4. `POST /typecheck` `{files: {guest.ts: clean}, runs: 3}` →
   `{runs: 3, results: [183, 177, 165 ms], minMs: 165, medianMs: 177, meanMs: 175, coldMs: 183}`
   — wasm warm in the hundreds of ms, cold (183) > best warm (165), stats coherent, all ok:true.
5. Teardown: `process.kill(-pid, SIGTERM)` → wrangler + workerd down, port verified closed. ✓

## Bench (verifier's run: native vs ts-js vs wasm)

linux arm64, Node v24.19.0, tsc-rs 0.2.0 (native), typescript 6.0.3 in-isolate (ts-js),
ts-rust wasm pin 569df52 in-isolate (TSCHECKER=tsc-rs-wasm). Native spawn+init 2.3 ms median.

| snippet | tsc-rs cold | tsc-rs warm med(10) | tsc-rs warm min | ts-js cold | ts-js warm med(5) | wasm cold | wasm warm med(5) | errors (exp/got) |
|---|---|---|---|---|---|---|---|---|
| slugify-iter1 | 38.5 | 30.6 | 28.8 | 223.0 | 8.0 | 561.0 | 181.0 | 2/2 |
| slugify-final | 33.1 | 30.4 | 29.5 | 7.0 | 5.0 | 167.0 | 154.0 | 0/0 |
| fibonacci-final | 35.2 | 29.9 | 29.2 | 11.0 | 5.0 | 163.0 | 147.0 | 0/0 |
| lib-heavy | 36.6 | 29.1 | 27.7 | 30.0 | 11.0 | 166.0 | 147.0 | 0/0 |
| synthetic-100 | 31.8 | 31.2 | 27.5 | 21.0 | 12.0 | 156.0 | 144.0 | 0/0 |

Error counts exact on all five snippets on the native leg and verdict-exact on both in-isolate
legs. Headline: warm-for-warm, ts-js 5–12 ms, native ~29–31 ms, wasm 144–181 ms — the real Rust
compiler costs ~25–30× ts-js per check inside the isolate, and is the only one of the three
actually running where the loop runs. Consistent with the committed run (wasm warm 145–180).

## Gaps

1. **`.planning/REQUIREMENTS.md` Traceability rows for WASM-01..05 still read "Planned"** —
   should flip to "Done" now that the phase is delivered. Bookkeeping only; the Milestone v3
   block itself is defined and the Out-of-Scope row is corrected (plan-review issue 7 resolved).
2. **`docs/benchmarks.md` working-tree copy is regenerated by every bench run** (by design —
   the script rewrites the file; timings differ run to run). My verification bench left the
   tree 7 lines ahead of HEAD (timestamp + row timings). Not committed, per verifier
   instructions; rerun `npm run bench:tsc-rs` anytime to regenerate. HEAD's committed numbers
   are the real T3 run and remain the record of note alongside the table above.
3. **Documented executor deviations re-verified as content-accurate**: `getTypechecker(env)`
   grep = 4 in src/index.ts, `TscRsWasmTypechecker` = 3 in src/typecheck/index.ts,
   `wasm warm med(5)` = 2 in README — each is a plan-internal miscount; the code/docs follow
   the plans' own mandatory verbatim blocks. No action needed.

None of the above blocks any WASM requirement. **Phase 6 / Milestone v3: DELIVERED.**
