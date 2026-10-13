# 06-01 Summary: Vendor ts_rust.wasm + workerd shim + TscRsWasmTypechecker behind TSCHECKER selection

**Status:** COMPLETE (all 4 tasks delivered; 1 minor type-level fix within intent; 1 plan-internal grep miscount documented)

**Executed:** 2026-10-13 | **Plan:** 06-01 rev 1 | **Executor:** gsd-executor

## Per-task notes

### T1 — Vendor artifact + provenance doc — DONE (commit `0f697bb`)
- `/tmp/tsrust-spike` intact; copied `probe/src/ts_rust.wasm` → `src/typecheck-wasm/ts_rust.wasm` via `cp` per plan.
- **sha256 verified byte-exact**: `6e71a7b82eff24106fe065358b48708875fc4598921727b5d6f55813c1362eb3`, size `5125434` — both match the plan's recorded values (no rebuild needed).
- `docs/ts-rust-wasm.md` written verbatim (pin `569df525…7480`, toolchain, rebuild steps, hosting model, known limits). All 8 verify greps match expected counts (1/1/1/2/1/3/2 + size/sha checks).

### T2 — memfs + mapping + spec — DONE (commit `718a80e`)
- `memfs.ts` (zero imports), `mapping.ts` (single `import type`), `test/typecheck-wasm-mapping.spec.ts` (11 tests) written per plan.
- All acceptance greps match hand-traced counts (`createMemoryFileSystem` 1, error strings 1+1, `CATEGORY_NAMES` 2, `/app/` -o 3 / -c 2, `(program)` 1, `toBeUndefined` 9).
- vitest after T2: **6 files / 52 tests**, all pass.
- **Deviation (type-level only, 2 lines):** the plan's verbatim content failed `npm run check` under this repo's TS 6.0.3 + workers-types 5.20261010.1:
  1. `TextDecoderConstructorOptions` requires both `fatal` and `ignoreBOM` → `{ ignoreBOM: true }` → `{ ignoreBOM: true, fatal: false }` (runtime-identical; `fatal` defaults false).
  2. TS 6.0.3's lib resolves `Object.entries(Map)` to the index-signature overload, inferring `Map<string, unknown>` → added `as [string, string][]` on the `Object.entries(files)` result in the (defensive, Map-else) branch. Runtime behavior unchanged.
  The plan's own verify gate (`npm run check` exits 0) was impossible without these; fixes are the minimal such change.

### T3 — workerd shim — DONE (commit `b708c8d`)
- `shim.ts` written verbatim from the plan: `ts_host.fs`/`fs_take` fs bridge over memfs, working WASI subset, imports-driven ENOSYS(52) wiring, `WasiExit` for `proc_exit`, fresh `WebAssembly.Instance` per `runTsc` call, `assertModuleShape()` first-use integrity assert, instantiate/run timings.
- Typed clean against workers-types on first try (verified `Imports`/`ImportValue`/`ExportValue`, `Module.imports/exports`, `performance.timeOrigin` beforehand). All 12 acceptance greps match expected counts exactly.

### T4 — Checker + selection + factory routing — DONE (commit `d3a4819`)
- `checker.ts` (TscRsWasmTypechecker: `/app` seeding + strict/es2022 tsconfig + GUEST_GLOBALS_TEXT, `-p /app --noEmit`, diagnostics JSON → mapping, `ok` iff no Error, ms timing) and `selection.ts` (pure `parseTSChecker`) written verbatim.
- `index.ts` edited per plan 4c–4f: imports added, seam comment corrected to the THREE-implementations form, boot-assert comment retitled, singleton split into `tsSingleton`/`wasmSingleton` with `getTypechecker(env)`/`getTypecheckerIdentity(env)` routing. `createTypechecker`/`TypecheckerKind` untouched (grep count still 1).
- `test/typecheck-selection.spec.ts` (5 tests) written verbatim.
- **Plan-internal inconsistency (no code deviation):** acceptance expects `grep -c "TscRsWasmTypechecker" src/typecheck/index.ts` = 2, but the plan's own verbatim 4c import + verbatim 4d seam comment ("…and TscRsWasmTypechecker (the real Rust checker…") + verbatim 4f factory produce **3** lines (index.ts:5, :26, :129). Both verbatim blocks are mandatory plan content, so count is 3 as written; the grep expectation miscounts the comment it itself mandates.

## Files + commits
| Commit | Files |
|---|---|
| `0f697bb` | `src/typecheck-wasm/ts_rust.wasm` (vendored, 5,125,434 bytes, sha256 `6e71a7b8…c1362eb3`), `docs/ts-rust-wasm.md` |
| `718a80e` | `src/typecheck-wasm/memfs.ts`, `src/typecheck-wasm/mapping.ts`, `test/typecheck-wasm-mapping.spec.ts` |
| `b708c8d` | `src/typecheck-wasm/shim.ts` |
| `d3a4819` | `src/typecheck-wasm/checker.ts`, `src/typecheck/selection.ts`, `src/typecheck/index.ts`, `test/typecheck-selection.spec.ts` |

Nothing pushed; `.planning/` not committed.

## Gate results
- `npm run check` (tsc --noEmit): **exit 0** at every task boundary.
- `npx vitest run`: **7 files / 57 tests, all passing** (baseline 5/41 + 11 mapping/memfs + 5 selection = the plan's expected 57). Small-module discipline held: memfs 0 imports, mapping 1 type-only import, selection 0 imports — the wasm module is never instantiated in unit specs.
- `npm run gate:no-host-eval`: **pass**.
- `npm run bundle:check` (dry-run, no runtime boot): Total Upload 16,889.19 KiB / gzip 4,187.60 KiB; `dist-bundle/` carries **exactly 2 .wasm files** (quickjs + `…-ts_rust.wasm` at 5,125,434 bytes) — the unconditional-ship decision confirmed, `wrangler.jsonc` untouched.
- sha256 of committed artifact re-verified post-commit: `6e71a7b82eff24106fe065358b48708875fc4598921727b5d6f55813c1362eb3`.

## Deviations from plan (complete list)
1. **T2 memfs.ts, 2 type-level line fixes** (detailed above) — required to satisfy the plan's own `npm run check` gate; runtime-identical.
2. **T4 acceptance grep `TscRsWasmTypechecker` = 3 not 2** — plan-internal miscount; code follows the plan's verbatim blocks exactly.
3. **`npm run bench:tsc-rs` NOT run** — executor instructions for this run explicitly said "No wrangler boots in this plan"; the plan's verification block lists it (it boots wrangler dev). The bundle-level proof (`bundle:check` shipping both wasm artifacts) was run instead; the in-workerd behavior leg is 06-02's live harness anyway (plan already says `test:live` is not a gate here).
