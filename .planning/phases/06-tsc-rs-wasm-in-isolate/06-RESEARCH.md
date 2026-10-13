# Phase 6 Research: ts_wasm build + workerd spike

**Phase:** 06 | **Researched:** 2026-10-13

## Verdict

- **BUILD OK** — `crates/ts_wasm` builds to `ts_rust.wasm` (5,125,434 bytes / 2.19 MB gzip) via their own `scripts/wasm/build.sh` path on this sandbox (aarch64 Linux, 4 cores); total wall ~6.5 min, no failures. Their full `npm/wasm` test suite passes 14/14 (after clearing a sandbox-only Node execArgv issue that affects the test harness's `worker_threads` wrapper, not the module).
- **WORKERD OK** — the module compiles, instantiates, and runs inside `wrangler dev` (wrangler 4.149.0, compatibility_date 2026-09-01, no nodejs_compat). Clean guest → 0 diagnostics; `const n: number = 'one'` → real TS2322 JSON. **The seam is viable; Phase 6 is a positive result.**

## Toolchain + Pin

| Item | Value |
|---|---|
| rustc / cargo | 1.99.0 (stable-aarch64-unknown-linux-gnu, rustup, minimal profile) |
| target | wasm32-wasip1 (`rustup target list --installed` confirms) |
| binaryen | wasm-opt version 132 (npm `binaryen@132`, local install; global `npm i -g` blocked by sandbox permissions) |
| ts-rust pin | **`569df525d3adfe55d31f1b027569a51953707480`** (depth-1 clone, 2026-10-13, "docs(state): followups61 result") |
| module (final) | **5,125,434 bytes raw / 2,186,278 gzip** (`npm/wasm/ts_rust.wasm`) |
| module (pre-wasm-opt cargo output) | 8,202,316 bytes (`target/wasm32-wasip1/wasm/ts_wasm.wasm`) |
| module compile time | 26 ms in Node (V8). In workerd, CompiledWasm compiles at bundle load; first request after boot (cold /check) took 1.22 s end-to-end |
| module link settings | `-zstack-size=33554432` (32 MiB shadow stack, from crates/ts_wasm/build.rs); profile `wasm` = opt-level z, fat LTO, codegen-units 1, panic=abort |
| embedded libs | lib.d.ts set is embedded **inside the module** and LZMA-decoded in-Rust at runtime (`lzma-rust2` crate) — no external lib assets to vendor, no host-side LZMA step |

Sandbox deviation: the brief said `/tmp/opencode/tsrust-spike`, but `/tmp/opencode` is root-owned and not writable by this user (no sudo). Everything was done in **`/tmp/tsrust-spike`** instead.

## Module Import Surface

From `WebAssembly.Module.imports()` (identical in Node and workerd — verified both):

- **`ts_host.fs(op: i32, ptr: i32, len: i32) -> i32`** — host FS bridge. `op` ∈ {READ=0, STAT=1, READ_DIR=2, REALPATH=3, WRITE=4, APPEND=5, REMOVE=6, CHTIMES=7}; request bytes at `ptr/len` are UTF-8 (NUL-separated for writes/chtimes). Return: byte length of the staged result (staged into `fs_take`), `-1` = not found/failed, `-2-len` = failed with an error string (tsc reports it verbatim).
- **`ts_host.fs_take(ptr: i32)`** — copy the previously staged result bytes into module memory at `ptr`.
- **`wasi_snapshot_preview1`** (23 imports): `args_sizes_get`, `args_get`, `environ_sizes_get`, `environ_get`, `clock_time_get`, `clock_res_get`, `random_get`, `fd_write`, `fd_fdstat_get`, `fd_prestat_get`, `fd_prestat_dir_name`, `fd_read`, `fd_readdir`, `fd_close`, `fd_filestat_get`, `fd_filestat_set_times`, `path_open`, `path_filestat_get`, `path_create_directory`, `path_readlink`, `path_remove_directory`, `path_unlink_file`, `proc_exit`, `sched_yield`. core.js implements a working subset (args/env/clock/random/fd_write/fd_fdstat_get/fd_prestat_get/proc_exit/sched_yield/poll_oneoff) and maps **every unimplemented one to a stub returning ENOSYS (52)** — a workerd host needs exactly the same trick.
- **Exports**: `memory`, `ts_input(len: i32) -> ptr`, `ts_run() -> exitCode`, `ts_output() -> ptr`, `ts_output_len() -> i32`.
- **Run protocol** (from core.js `prepareRun`/`start`/`result`): request = `[cwd, flags, ...args].join("\0")` UTF-8; flags bit 0 = diagnostics-JSON. `ts_input(len)` allocates, host writes request, `ts_run()` executes (may throw via `proc_exit`), then `ts_output/ts_output_len` return the diagnostics JSON buffer.
- **Host APIs the shim needs** (all present in workerd): `WebAssembly` (Module.imports/Instance), `TextEncoder`/`TextDecoder` (incl. `{ignoreBOM:true}`), `crypto.getRandomValues`, `performance.now`/`timeOrigin` (core.js uses `timeOrigin + now` for wall clock; guard with `Date.now` fallback — my probe did, workerd has `timeOrigin`). **No Node APIs in core.js** — the Node-specific bits (`worker_threads` 256 MB stacks, real fs) live in `node.js`/`node-worker.js`, which we do not vendor.
- Diagnostics JSON shape (file diagnostics): `{fileName, pos, end, startPosition:{line,character}, endPosition:{line,character}, sourceLines:[{line,text}], code, category, text}`; config diagnostics: `{pos:-1, end:-1, code, category, text}`. 1-based `code` semantics identical to tsgo per their tests.

## Build Log Summary

1. `rustup` stable + minimal → **49 s**; `rustup target add wasm32-wasip1` → included in same step.
2. `npm i binaryen` (local prefix, `tools/node_modules/.bin` on PATH) → wasm-opt 132. (`npm i -g` failed: sandbox global prefix not writable — expected, worked around.)
3. `git clone --depth 1 pingdotgg/ts-rust` → pin `569df52…`.
4. `CI=1 bash scripts/wasm/build.sh` (CI=1 bypasses their `systemd-run` capped runner — no systemd user session here; this is their documented CI path):
   - `cargo rustc --profile wasm -p ts_wasm --lib --target wasm32-wasip1 -- -C strip=debuginfo` → **2 m 59 s** (all deps + ts_goport rlib + fat-LTO cdylib link; 4 cores, ~1.2 GB peak RSS on the final rustc).
   - `order-functions.mjs hide` → `wasm-opt --flatten --rereloop -Oz -Oz` (+6 feature flags) → `order-functions.mjs key` → `wasm-opt -s 2 --reorder-functions-by-name --strip-debug --strip-producers` → **~3 min** (wasm-opt peaked ~405 MB, ~104% CPU).
   - Path-leak self-check (greps the module for build paths) → clean.
   - **Total wall ≈ 6.5 min** — far under the 10–45 min estimate. No OOM, no timeouts (one process-group kill on the first launch attempt because the tool shell timed out on the backgrounding call; relaunched with `setsid nohup` and the run was clean).
5. Failure note: first build launch died silently when the tool shell terminated the command after 120 s (killed the whole process group despite `nohup`). **Lesson: `setsid` + `disown`, not bare `nohup &`, for long builds from this shell.**

## Verification (Node, before workerd)

- Their suite `npm test` (`node --test test/*.test.mjs`): raw run = 3/14 pass, 11 fail — **all 11** with `ERR_WORKER_INVALID_EXEC_ARGV` inside `node.js:68` (`new Worker(...)` inherits this sandbox's Node launch flags, which Node refuses to pass to worker_threads; harness/environment issue, not the module). With `process.execArgv = []` preloaded: **14/14 pass**, including JSON diagnostics, DOM lib, emit, symlink cwd, slow-pipe stdout, write-error reporting, watch-mode refusal.
- My smoke (`runTsc` + `memoryFileSystem` from core.js):
  - clean guest (`-p /app --noEmit`, strict, es2022): exit 0, `diagnostics: []` — **1326 ms first run** (per-process warm-up: V8 tier-up + first lib decode), then ~760 ms.
  - `const n: number = 'one'` → exit 2, diagnostics codes **[2322]**.
  - warm clean guest, 10 runs: median **762 ms**, min 753, max 800.

## workerd Probe

Scratch project `/tmp/tsrust-spike/probe`: wrangler **4.149.0**, `compatibility_date "2026-09-01"`, `compatibility_flags ["no_nodejs_compat","no_nodejs_compat_v2"]` (accepted without warnings; default is no-compat anyway), `main src/worker.js`, module imported as `import wasmModule from "./ts_rust.wasm"` → CompiledWasm. `src/worker.js` is a faithful port of core.js's shim: `ts_host.fs`/`fs_take` over an in-memory Map, WASI subset + ENOSYS stubs for the rest (`clock_time_get` via `performance.timeOrigin+now`, `random_get` via `crypto.getRandomValues`, `fd_write` → captured strings), `proc_exit` → thrown `WasiExit`, **fresh `new WebAssembly.Instance(module, imports)` per request**, `POST /check {files, args?}` returns `{exitCode, diagnostics, stdout, stderr, timings:{instantiateMs, runMs, cold}}`.

**`curl http://127.0.0.1:18731/healthz`** → 200, module introspection OK, imports/exports identical to Node (18 ms RTT; module already compiled by bundle load).

**Clean guest (cold — first instantiate+check after boot):**

```json
{"exitCode":0,"diagnostics":[],"stdout":"","stderr":"","timings":{"instantiateMs":2,"runMs":1198,"cold":true}}
```

**TS2322 guest (`const n: number = 'one'`, strict):**

```json
{"exitCode":2,"diagnostics":[{"fileName":"/app/index.ts","pos":6,"end":7,"startPosition":{"line":0,"character":6},"endPosition":{"line":0,"character":7},"sourceLines":[{"line":0,"text":"const n: number = 'one';\n"}],"code":2322,"category":1,"text":"Type 'string' is not assignable to type 'number'."}],"stdout":"","stderr":"","timings":{"instantiateMs":7,"runMs":689,"cold":false}}
```

**Warm, 10 × clean guest:** instantiate **2–8 ms**, run **606–650 ms** (median ≈ 625 ms per check, fresh instance each time); wrangler logs all `POST /check 200 OK (615–642 ms)`. Cold ≈ warm + ~550 ms (first-run tier-up inside the isolate).

So per-request cost model in workerd: **~6 ms fresh instance + ~0.6–1.2 s check** on this 4-core aarch64 sandbox. (Native tsgo would be far faster, but this is the in-isolate WASM story — and it fits comfortably in request scope for small guests.)

## Recommended Integration Plan Inputs

**Vendor inventory:**
- `ts_rust.wasm` — 5,125,434 bytes raw / 2,186,278 gzip. Ship via CompiledWasm import exactly like `src/sandbox/quickjs.wasm` (wrangler bundles any `.wasm` import; no `rules` entry needed).
- Shim source: port of `npm/wasm/core.js` — proven working in `probe/src/worker.js` (~370 lines, zero deps). Functions to port: `prepareRun`, `runTsc` (+ timings), `memoryFileSystem`, `WasiExit`, `fsCall`, WASI table. Do NOT vendor `node.js`/`node-worker.js`/`node-run.js`/`bin/`.
- Entry call: `ts_input(len)` ← request bytes `[cwd, flags, ...args].join("\0")`; `ts_run()`; `ts_output()`/`ts_output_len()` → JSON parse. Flags: bit0 diagnosticsJson, bit1 caseInsensitive. `proc_exit` must be caught as `WasiExit`.
- Rebuild pin: `CI=1 WASM_PROFILE=wasm scripts/wasm/build.sh` at commit `569df525d3adfe55d31f1b027569a51953707480` (rustc 1.99.0, binaryen ≥132; ~6.5 min; docs quote 4.2 MB with Rust 1.98.1 — we got 5.1 MB with 1.99.0, toolchain-version-sensitive, record whichever rustc built it).

**`TscRsWasmTypechecker` shape:** construct one `WebAssembly.Instance` per check (matches module's one-run-per-instance design; 2–8 ms each — negligible next to the check). Feed `files` through `memoryFileSystem(files)`, args `["-p","/app","--noEmit"]` (or emit-less config), `diagnosticsJson: true`, `env {NO_COLOR:"1"}`. Map diagnostics `{fileName, startPosition, code, text}` onto the existing `TypecheckDiagnostic` shape. Health identity: `tsc-rs-wasm@569df52` when selected.

**Risks (document, not solve — per phase decisions):**
- **Stack depth**: 32 MiB in-linear-memory shadow stack (build.rs); deep checker recursion traps rather than corrupts, and a trap surfaces as a thrown error with stderr — same class as QuickJS aborts. Guests here are small.
- **Sync instantiate + sync `ts_run()` on the request thread**: worked under local `wrangler dev` with zero flags (no threads/JSPI imports in the module — it needs only bulk-memory/multivalue/reference-types/sign-ext/mutable-globals, all baseline in workerd). A ~0.6–1.2 s synchronous CPU-bound run is fine locally; production CPU limits would need a paid plan's 30 s ceiling — local dev doesn't enforce, and the prototype is local-only.
- **Per-run instance cost**: 2–8 ms instantiate is a rounding error; no instance pooling needed.
- Module size: 5.1 MB raw / 2.2 MB gzip — well inside the 64 MiB uncompressed worker limit; bundles alongside QuickJS wasm fine.
- Their test suite needs Node ≥22 + a clean `execArgv` to run in CI sandboxes like this one (the `ERR_WORKER_INVALID_EXEC_ARGV` issue) — run via `node --import ./reset-execargv.mjs --test` if the harness injects flags.

## Sources

- Empirical, this spike (all commands + outputs in `/tmp/tsrust-spike/`): toolchain.log, build.log, `npm/wasm` test runs (raw 3/14 → 14/14 with execArgv reset), `smoke.mjs` output, probe/wrangler.log + curl transcripts (healthz, clean cold, TS2322, 10 warm).
- `pingdotgg/ts-rust@569df52` source read: `scripts/wasm/build.sh` (build steps, wasm-opt flags, remap check), `crates/ts_wasm/Cargo.toml` + `build.rs` (cdylib, `-zstack-size=33554432`, `wasm` profile in workspace Cargo.toml), `npm/wasm/core.js` (import surface, run protocol, memoryFileSystem), `npm/wasm/test/tsc.test.mjs` (expected diagnostics shapes), `npm/wasm/package.json` (`npm test` = `node --test`), `crates/ts_goport/parts/goport_util/Cargo.toml` (lzma-rust2 embedding note).
- Local environment: `wrangler dev` 4.149.0 boot log (no compat-flag warnings), `WebAssembly.Module.imports/exports` from both Node and workerd.
