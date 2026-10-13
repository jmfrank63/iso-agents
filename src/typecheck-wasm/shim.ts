// workerd-safe host shim for the vendored ts_rust.wasm (WASM-01): a
// TypeScript port of pingdotgg/ts-rust@569df52 npm/wasm/core.js's import
// surface, proven inside wrangler dev by the 06-RESEARCH spike. The
// Node-specific parts of core.js (worker_threads 256 MB stacks, real fs) are
// deliberately NOT ported: the run is synchronous on the calling thread and
// every check gets a FRESH WebAssembly.Instance — the module's own
// one-run-per-instance design (2-8 ms instantiate vs a ~0.6-1.2 s check —
// 06-RESEARCH). Documented-not-solved (06-CONTEXT): with no JSPI in workerd,
// deep checker recursion can trap the instance; the trap surfaces as a
// thrown host error, the same class as QuickJS aborts. Guests here are
// small.
//
// Import surface (06-RESEARCH, identical in Node and workerd):
//   ts_host.fs(op, ptr, len) -> staged result byte length; -1 not
//                              found/failed; -2-len failed with an error
//                              string (tsc reports it verbatim)
//   ts_host.fs_take(ptr)     -> copy the staged bytes into module memory
//   wasi_snapshot_preview1.* -> the working subset below; EVERY other
//                              import the module declares is wired to an
//                              ENOSYS (52) stub, exactly like core.js.
// Exports used: memory, ts_input(len), ts_run(), ts_output(),
// ts_output_len(). Run protocol: request = [cwd, flags, ...args]
// .join("\0") UTF-8; flags bit 0 = diagnostics JSON, bit 1 =
// case-insensitive; proc_exit surfaces as a thrown WasiExit.
import wasmModule from "./ts_rust.wasm";
import { createMemoryFileSystem, type MemoryFileSystem } from "./memfs";
import type { WasmDiagnostic } from "./mapping";

// The upstream commit the committed artifact was built from
// (docs/ts-rust-wasm.md holds the full pin + sha256).
export const TS_RUST_PIN = "569df52";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const STREAM_DECODER = new TextDecoder();
const STDERR_DECODER = new TextDecoder();

const FLAG_DIAGNOSTICS_JSON = 1;
const FLAG_CASE_INSENSITIVE = 2;

const SUCCESS = 0;
const EBADF = 8;
const ENOSYS = 52;

// proc_exit must surface as a catchable host error (core.js contract) —
// ts_run() raises it for normal exits too; it is not a crash.
class WasiExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

// ts_host.fs op codes (06-RESEARCH import surface).
const OP_READ = 0;
const OP_STAT = 1;
const OP_READ_DIR = 2;
const OP_REALPATH = 3;
const OP_WRITE = 4;
const OP_APPEND = 5;
const OP_REMOVE = 6;
const OP_CHTIMES = 7;

const KIND_CHAR: Record<string, string> = { file: "f", directory: "d", symlink: "l", other: "o" };

// fs-bridge results: staged bytes, or an error string the module surfaces
// through the -2-len return convention.
type FsCallResult = { bytes: Uint8Array } | { error: string } | undefined;

function writeResult(result: string | undefined): FsCallResult {
  return typeof result === "string" ? { error: result } : { bytes: new Uint8Array() };
}

// Decode one ts_host.fs op against the check's in-memory filesystem.
// Request bytes at ptr/len are UTF-8, NUL-separated for write/chtimes.
function fsCall(fs: MemoryFileSystem, op: number, request: Uint8Array): FsCallResult {
  const text = DECODER.decode(request);
  switch (op) {
    case OP_READ: {
      const data = fs.readFile(text);
      return data === undefined ? undefined : { bytes: ENCODER.encode(data) };
    }
    case OP_STAT: {
      const stat = fs.stat(text);
      if (!stat) return undefined;
      const kind = stat.isDirectory ? "d" : stat.isFile === false ? "o" : "f";
      const ns = stat.mtimeNs ?? BigInt(Math.round((stat.mtimeMs ?? 0) * 1e6));
      return { bytes: ENCODER.encode(`${kind} ${stat.size ?? 0} ${ns}`) };
    }
    case OP_READ_DIR: {
      const entries = fs.readDirectory(text);
      if (!entries) return undefined;
      return {
        bytes: ENCODER.encode(entries.map((e) => `${KIND_CHAR[e.kind] ?? "o"}${e.name}\0`).join("")),
      };
    }
    case OP_REALPATH: {
      const real = fs.realpath(text);
      return real === undefined ? undefined : { bytes: ENCODER.encode(real) };
    }
    case OP_WRITE:
    case OP_APPEND: {
      const nul = request.indexOf(0);
      const path = DECODER.decode(request.subarray(0, nul));
      const data = request.subarray(nul + 1);
      return writeResult(fs.writeFile(path, data, op === OP_APPEND));
    }
    case OP_REMOVE:
      return writeResult(fs.remove(text));
    case OP_CHTIMES: {
      const [path, atime, mtime] = text.split("\0");
      if (!fs.chtimes) return { bytes: new Uint8Array() };
      return writeResult(
        fs.chtimes(path, atime ? BigInt(atime) : undefined, mtime ? BigInt(mtime) : undefined),
      );
    }
    default:
      return undefined;
  }
}

type TsRustExports = {
  memory: WebAssembly.Memory;
  ts_input(len: number): number;
  ts_run(): number;
  ts_output(): number;
  ts_output_len(): number;
};

type TsHostImports = {
  fs: (op: number, ptr: number, len: number) => number;
  fs_take: (ptr: number) => void;
};

interface PrepareRunOptions {
  args?: string[];
  cwd?: string;
  fs: MemoryFileSystem;
  env?: Record<string, string>;
  stdout: (chunk: Uint8Array) => void;
  stderr: (chunk: Uint8Array) => void;
  diagnosticsJson?: boolean;
  caseInsensitive?: boolean;
  tty?: boolean;
}

// One prepared run: host imports built, ready for `new WebAssembly.Instance`
// + start() + result(). Every memory view is rebuilt per access — ts_run()
// can grow the memory, which detaches stale ArrayBuffers (core.js behavior).
function prepareRun(module: WebAssembly.Module, options: PrepareRunOptions) {
  const {
    args = [],
    cwd = "/",
    fs,
    env = {},
    stdout,
    stderr,
    diagnosticsJson = false,
    caseInsensitive = false,
    tty = false,
  } = options;
  for (const value of [cwd, ...args, ...Object.entries(env).flat()]) {
    if (typeof value === "string" && value.includes("\0")) {
      throw new TypeError(
        `ts-rust: cwd, args and env must not contain NUL bytes: ${JSON.stringify(value)}`,
      );
    }
  }
  let memory!: WebAssembly.Memory;
  let exports!: TsRustExports;
  let staged: Uint8Array | undefined;
  let stderrText = "";
  const u8 = (): Uint8Array => new Uint8Array(memory.buffer);
  const dv = (): DataView => new DataView(memory.buffer);

  const envBytes = Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ENCODER.encode(`${k}=${v}\0`));
  const writeStrings = (list: Uint8Array[], ptrs: number, buf: number): number => {
    const view = dv();
    let at = buf;
    list.forEach((bytes, i) => {
      view.setUint32(ptrs + i * 4, at, true);
      u8().set(bytes, at);
      at += bytes.length;
    });
    return SUCCESS;
  };
  const sizes = (list: Uint8Array[], countPtr: number, sizePtr: number): number => {
    dv().setUint32(countPtr, list.length, true);
    dv().setUint32(sizePtr, list.reduce((n, b) => n + b.length, 0), true);
    return SUCCESS;
  };

  // Wall clock for clock_time_get: timeOrigin + now (workerd has timeOrigin;
  // guard with Date.now anyway, mirroring the spike probe).
  const wallNow = (): number => {
    const origin = typeof performance.timeOrigin === "number" ? performance.timeOrigin : Date.now();
    return origin + performance.now();
  };

  // Working WASI subset (core.js parity) under a uniform
  // (i32, i32, i32, i32) => i32 typing that fits every member.
  const wasiTable: Record<string, (a: number, b: number, c: number, d: number) => number> = {
    args_sizes_get: (countPtr, sizePtr) => sizes([], countPtr, sizePtr),
    args_get: () => SUCCESS,
    environ_sizes_get: (countPtr, sizePtr) => sizes(envBytes, countPtr, sizePtr),
    environ_get: (ptrs, buf) => writeStrings(envBytes, ptrs, buf),
    clock_time_get: (id, _precision, out) => {
      const ms = id === 0 ? wallNow() : performance.now();
      dv().setBigUint64(out, BigInt(Math.round(ms * 1e6)), true);
      return SUCCESS;
    },
    clock_res_get: (_id, out) => {
      dv().setBigUint64(out, 1000n, true);
      return SUCCESS;
    },
    random_get: (buf, len) => {
      for (let at = 0; at < len; at += 65536) {
        crypto.getRandomValues(u8().subarray(buf + at, buf + Math.min(len, at + 65536)));
      }
      return SUCCESS;
    },
    fd_write: (fd, iovs, iovsLen, nwritten) => {
      if (fd !== 1 && fd !== 2) return EBADF;
      const view = dv();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        const chunk = u8().slice(ptr, ptr + len);
        if (fd === 1) stdout(chunk);
        else {
          stderrText += STDERR_DECODER.decode(chunk, { stream: true });
          stderr(chunk);
        }
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return SUCCESS;
    },
    fd_fdstat_get: (fd, out) => {
      if (fd > 2) return EBADF;
      u8().fill(0, out, out + 24);
      dv().setUint8(out, fd === 1 && tty ? 2 : 0);
      return SUCCESS;
    },
    fd_prestat_get: () => EBADF,
    proc_exit: (code): number => {
      throw new WasiExit(code);
    },
    sched_yield: () => SUCCESS,
    poll_oneoff: (_in, _out, _n, nevents) => {
      dv().setUint32(nevents, 0, true);
      return SUCCESS;
    },
  };

  // Wire the module's ACTUAL import list: implemented WASI fields get the
  // table entry, every other wasi import gets an ENOSYS stub — identical to
  // core.js's imports-driven loop (no guessing the upstream import list).
  const wasiImports: Record<string, (a: number, b: number, c: number, d: number) => number> = {};
  for (const { module: name, name: field } of WebAssembly.Module.imports(module)) {
    if (name === "wasi_snapshot_preview1") {
      wasiImports[field] = wasiTable[field] ?? (() => ENOSYS);
    }
  }
  const imports: WebAssembly.Imports = {
    wasi_snapshot_preview1: wasiImports,
    ts_host: {
      fs: (op: number, ptr: number, len: number): number => {
        const result = fsCall(fs, op, u8().slice(ptr, ptr + len));
        if (result === undefined) return -1;
        if ("error" in result) {
          staged = ENCODER.encode(result.error);
          return -2 - staged.length;
        }
        staged = result.bytes;
        return staged.length;
      },
      fs_take: (ptr: number): void => {
        // Defensive: never observed (the core.js contract orders fs -> fs_take).
        if (staged === undefined) return;
        u8().set(staged, ptr);
        staged = undefined;
      },
    },
  };

  return {
    imports,
    start(instance: WebAssembly.Instance): () => number {
      exports = instance.exports as TsRustExports;
      memory = exports.memory;
      let flags = 0;
      if (diagnosticsJson) flags |= FLAG_DIAGNOSTICS_JSON;
      if (caseInsensitive) flags |= FLAG_CASE_INSENSITIVE;
      const request = ENCODER.encode([cwd, String(flags), ...args].join("\0"));
      const input = exports.ts_input(request.length);
      u8().set(request, input);
      return exports.ts_run;
    },
    result(exitCode: number, error: unknown): { exitCode: number; diagnostics: WasmDiagnostic[] } {
      if (error !== undefined) {
        if (!(error instanceof WasiExit)) {
          // A real crash (the wasm-trap class): attach the captured stderr
          // for the caller and rethrow — same surface as core.js.
          (error as { stderr?: string }).stderr = stderrText + STDERR_DECODER.decode();
          throw error;
        }
        exitCode = error.code;
      }
      let diagnostics: WasmDiagnostic[] = [];
      if (diagnosticsJson) {
        const ptr = exports.ts_output();
        const len = exports.ts_output_len();
        diagnostics = len
          ? (JSON.parse(DECODER.decode(u8().subarray(ptr, ptr + len))) as WasmDiagnostic[])
          : [];
      }
      return { exitCode, diagnostics };
    },
  };
}

export interface WasmRunTimings {
  instantiateMs: number;
  runMs: number;
}

export interface WasmRunResult {
  exitCode: number;
  diagnostics: WasmDiagnostic[];
  stdout: string;
  stderr: string;
  timings: WasmRunTimings;
}

export interface RunTscOptions {
  // Seeded in-memory filesystem: absolute path -> text. The embedded lib
  // set needs no seeds; the checker adds tsconfig + guests.
  files: Map<string, string>;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  diagnosticsJson?: boolean;
}

// Vendored-artifact integrity assert (the TYPE-01 assert precedent): runs
// once, on the first runTsc call, and fails loudly if the committed
// ts_rust.wasm does not match pin 569df52's import/export surface (e.g. a
// stale or corrupt copy replaced the artifact).
let shapeChecked = false;
function assertModuleShape(): void {
  if (shapeChecked) return;
  const importNames = WebAssembly.Module.imports(wasmModule).map((i) => `${i.module}.${i.name}`);
  const exportNames = WebAssembly.Module.exports(wasmModule).map((e) => e.name);
  for (const required of ["ts_host.fs", "ts_host.fs_take"]) {
    if (!importNames.includes(required)) {
      throw new Error(
        `FATAL: ts_rust.wasm is missing the "${required}" import — the vendored artifact does not ` +
          `match ts-rust pin ${TS_RUST_PIN}; see docs/ts-rust-wasm.md`,
      );
    }
  }
  if (!importNames.some((name) => name.startsWith("wasi_snapshot_preview1."))) {
    throw new Error(
      `FATAL: ts_rust.wasm has no wasi_snapshot_preview1 imports — the vendored artifact does not ` +
        `match ts-rust pin ${TS_RUST_PIN}; see docs/ts-rust-wasm.md`,
    );
  }
  for (const required of ["memory", "ts_input", "ts_run", "ts_output", "ts_output_len"]) {
    if (!exportNames.includes(required)) {
      throw new Error(
        `FATAL: ts_rust.wasm is missing the "${required}" export — the vendored artifact does not ` +
          `match ts-rust pin ${TS_RUST_PIN}; see docs/ts-rust-wasm.md`,
      );
    }
  }
  shapeChecked = true;
}

// core.js runTsc, plus timings around instantiate and run. A FRESH
// WebAssembly.Instance per call (CONTEXT decision); the Module itself is
// compiled once at bundle load (CompiledWasm import).
export function runTsc(options: RunTscOptions): WasmRunResult {
  assertModuleShape();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const run = prepareRun(wasmModule, {
    args: options.args,
    cwd: options.cwd,
    fs: createMemoryFileSystem(options.files),
    env: options.env,
    stdout: (chunk) => stdoutChunks.push(STREAM_DECODER.decode(chunk, { stream: true })),
    stderr: (chunk) => stderrChunks.push(STREAM_DECODER.decode(chunk, { stream: true })),
    diagnosticsJson: options.diagnosticsJson,
  });
  const t0 = performance.now();
  const instance = new WebAssembly.Instance(wasmModule, run.imports);
  const t1 = performance.now();
  const tsRun = run.start(instance);
  let exitCode = SUCCESS;
  let error: unknown;
  try {
    exitCode = tsRun();
  } catch (thrown) {
    error = thrown;
  }
  const t2 = performance.now();
  const { exitCode: code, diagnostics } = run.result(exitCode, error);
  return {
    exitCode: code,
    diagnostics,
    stdout: stdoutChunks.join("").slice(0, 65536),
    stderr: stderrChunks.join("").slice(0, 65536),
    timings: { instantiateMs: t1 - t0, runMs: t2 - t1 },
  };
}
