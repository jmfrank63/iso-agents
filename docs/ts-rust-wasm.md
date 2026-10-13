# The vendored tsc-rs WASM checker (`src/typecheck-wasm/ts_rust.wasm`)

`crates/ts_wasm` in [pingdotgg/ts-rust](https://github.com/pingdotgg/ts-rust) builds ts_goport —
the Rust port of the TypeScript compiler (tsc 7.1.0-dev lineage) — to `wasm32-wasip1`. The
resulting module runs INSIDE this workerd isolate behind the `Typechecker` seam: select it with
`TSCHECKER=tsc-rs-wasm` (`wrangler dev --var TSCHECKER:tsc-rs-wasm`). Nothing is published on
npm, so the module is vendored here, built from source at the pin below.

## Provenance

| Item | Value |
|---|---|
| Upstream | pingdotgg/ts-rust (MIT — vendored artifact + adapted shim only; see upstream for the license text) |
| Pin | `569df525d3adfe55d31f1b027569a51953707480` ("docs(state): followups61 result", depth-1 clone 2026-10-13) |
| Artifact | `src/typecheck-wasm/ts_rust.wasm` — 5,125,434 bytes raw / 2,186,278 gzip |
| sha256 | `6e71a7b82eff24106fe065358b48708875fc4598921727b5d6f55813c1362eb3` |
| Built with | rustc/cargo 1.99.0 (stable-aarch64-unknown-linux-gnu, rustup minimal profile), target wasm32-wasip1, binaryen wasm-opt 132 (npm `binaryen@132`, local prefix) |
| Build | `CI=1 bash scripts/wasm/build.sh` in the clone (2026-10-13, aarch64 Linux, ~6.5 min wall) |
| npm status | **Unpublished; built from source at pin 569df52** — nothing from upstream `npm/wasm` is on the registry |

## Rebuild from source (~6.5 min)

The module is committed, so `npm install` has NO rustup/toolchain dependency. To reproduce or
upgrade the pin:

1. `rustup` stable + minimal profile; `rustup target add wasm32-wasip1` (~49 s combined on the
   spike machine).
2. Local binaryen: `npm i binaryen` and put that prefix's `node_modules/.bin` on PATH — wasm-opt
   ≥ 132 (a global `npm i -g` may be blocked by prefix permissions; the local install is the
   documented workaround).
3. `git clone --depth 1 https://github.com/pingdotgg/ts-rust` and RECORD the commit — that
   commit is the new pin.
4. `CI=1 bash scripts/wasm/build.sh` from the clone root. `CI=1` bypasses upstream's
   `systemd-run` capped runner (no systemd user session needed). Expect ~3 min cargo fat-LTO
   cdylib link (~1.2 GB peak RSS on the final rustc) + ~3 min wasm-opt (`--flatten --rereloop
   -Oz -Oz` then `-s 2 --reorder-functions-by-name --strip-debug --strip-producers`, ~405 MB
   peak). For long-running shells: `setsid` + disown the build, not a bare `nohup &`.
5. Verify: `npm test` inside the clone's `npm/wasm` — upstream suite, expected 14/14. If your
   sandbox injects Node execArgv flags, the worker_threads-based tests fail with
   `ERR_WORKER_INVALID_EXEC_ARGV`; reset `process.execArgv = []` first — harness issue, not the
   module.
6. Copy `npm/wasm/ts_rust.wasm` → `src/typecheck-wasm/ts_rust.wasm`, update the pin, sha256,
   byte size, and rustc version in this file, then re-run `npm run test:live` (the tsc-rs-wasm
   harness re-proves behavior; `src/typecheck-wasm/shim.ts` asserts the import/export surface on
   first use and fails loudly on a mismatched artifact).

Toolchain-version sensitivity: upstream's docs quote ~4.2 MB for the module (Rust 1.98.1); Rust
1.99.0 produced 5,125,434 bytes here. Record whichever rustc built YOUR artifact.

## How the worker hosts it (WASM-01/02/03)

- **Import**: `import wasmModule from "./ts_rust.wasm"` — wrangler's default CompiledWasm rule
  (NO `rules` entry needed; same mechanism as `src/sandbox/quickjs.wasm`, which coexists —
  `npm run bundle:check` ships both). The import is a precompiled `WebAssembly.Module`; the
  only legal instantiation in workerd is with host-supplied imports, which the shim provides.
- **Shim**: `src/typecheck-wasm/shim.ts` is a workerd-safe TypeScript port of upstream
  `npm/wasm/core.js`: `ts_host.fs`/`fs_take` over `memfs.ts`'s in-memory map, a working WASI
  subset (`args_sizes_get`/`args_get`/`environ_sizes_get`/`environ_get`/`clock_time_get`/
  `clock_res_get`/`random_get`/`fd_write`/`fd_fdstat_get`/`fd_prestat_get`/`proc_exit`/
  `sched_yield`/`poll_oneoff`), and ENOSYS (52) stubs wired to EVERY other import the module
  actually declares (imports-driven loop, like core.js). NO Node APIs: core.js's Node-only bits
  (`worker_threads` 256 MB stacks, real fs) are deliberately not ported — the run is synchronous
  on the calling thread.
- **Fresh instance per check**: the Module is compiled once at bundle load; every check builds
  a new `WebAssembly.Instance` (2–8 ms measured — negligible next to the check). This matches
  the module's own one-run-per-instance design; no instance pooling.
- **Run protocol**: request = `[cwd, flags, ...args].join("\0")` UTF-8 written via
  `ts_input(len)`; `ts_run()` executes; diagnostics JSON comes back from
  `ts_output()`/`ts_output_len()`; `proc_exit` surfaces as a thrown `WasiExit` (normal-exit
  control flow, not a crash).
- **Libs are INSIDE the module** (embedded LZMA, decoded in-Rust) — no lib assets are vendored
  or seeded by the host. Guest files + a strict/es2022 tsconfig are seeded under `/app` per
  check; diagnostics fileNames are mapped back to the repo's rooted form by `mapping.ts`.
- **Flags used**: bit 0 (diagnostics JSON) only. `--watch`/`--lsp`/`--api` do not exist in the
  wasm build.

## Known limits (documented, not solved — 06-CONTEXT)

- **Stack depth**: the module links a 32 MiB in-linear-memory shadow stack
  (`-zstack-size=33554432`). With no JSPI in workerd, deep checker recursion can trap the
  instance; a trap surfaces as a thrown host error with captured stderr (same class as QuickJS
  aborts) and the route returns the structured 500 envelope. Guests in this prototype are small.
- **Sync CPU-bound run**: spike-measured per request in workerd — cold ≈ 1.22 s, warm median
  ≈ 625 ms, instantiate 2–8 ms (fresh instance each time). Local `wrangler dev` does not enforce
  CPU limits; production would need a paid plan's 30 s ceiling. The prototype is local-only.
- **Per-run instance cost** is a rounding error; no pooling (see above).
