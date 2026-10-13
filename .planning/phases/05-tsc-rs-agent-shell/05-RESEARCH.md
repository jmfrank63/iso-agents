# Phase 5 Research: tsc-rs integration + agent shell runtime

**Phase:** 05
**Researched:** 2026-10-13

## Summary

**tsc-rs runs natively on this machine and both invocation modes work — no blocker.** The
empirical headline corrects the brief: this machine is **linux-arm64 (aarch64), node
v24.19.0**, not linux-x64. npm resolves the matching optional dep `@tsc-rs/linux-arm64@0.2.0`
(a native executable + lib `.d.ts` closure, not a `.node` addon), and it executes fine.
The **JS API is the recommended bench path** (CONTEXT preference honored): `new API({fs})`
from `tsc-rs/unstable/sync` spawns the binary as a persistent sync-RPC subprocess
(~2.5 ms), then per-check costs **cold ~34–48 ms / warm ~30–35 ms** on the bench snippets.
The **CLI fallback works too**: `tsc-rs --noEmit --strict --target es2022 --module esnext
--skipLibCheck <globals.d.ts> <guest.ts>` — no tsconfig needed, exit 0 clean / **2 on type
errors**, ~155–170 ms per fresh process (process+native-init dominated; the JS API's
persistent server is ~5x cheaper per check). Diagnostics are exact: slugify-iter1 yields
exactly the 2× TS2322 the in-isolate checker produces (first at 2:9), clean snippets yield
zero. Three empirical gotchas matter for the bench: the ambient test/expect file must be in
rootNames, the CLI needs `--skipLibCheck` (DOM lib vs ambient `console`), and tsc-rs's
default lib closure includes DOM while the in-isolate closure does not (harmless for these
snippets; footnote it). `/agent/shell` maps 1:1 onto existing primitives (plain `Map` VFS,
`transpileGuest` + `getSandboxRuntime(env)`, `getTypechecker()` singleton) with a
32-command / 1 MiB cap envelope; the loop is untouched. Warm-vs-warm, expect the honest
README story: in-isolate stays competitive on these tiny guests (its memoized-lib warm
check is 8–20 ms vs tsc-rs ~30 ms here); tsc-rs's win is cold/large-program checking, not
350-byte guests.

## tsc-rs On This Machine (EMPIRICAL)

Scratch dir: `/tmp/tscrs-scratch` (`/tmp/opencode` is not writable by this user — owned by
`ubuntu`; used a writable `/tmp` path instead). `npm i tsc-rs@0.2.0` succeeded.

### Platform + layout facts (verified, not assumed)

- **Machine:** `uname -m` = `aarch64` (**arm64** — the task brief's "linux-x64" is stale for
  this box), node v24.19.0. `@tsc-rs/linux-arm64@0.2.0` (`os: [linux], cpu: [arm64]`)
  installed as the optional dep. `@tsc-rs/linux-x64@0.2.0` also exists in optionalDeps, so
  x64 dev machines are covered by the same package version.
- **The native artifact is an executable**, `node_modules/@tsc-rs/linux-arm64/lib/tsc`, with
  the full default lib closure (`lib.es5.d.ts` … `lib.es2022.full.d.ts`, DOM included) in
  the same `lib/` dir. No `.node` addon, no dylib.
- **Package shape:** `"type": "module"`. Root export `.` = CJS stub
  `require("tsc-rs")` → `{version: "0.2.0", versionMajorMinor: "7.1"}`.
  `tsc-rs/unstable/sync` and `tsc-rs/unstable/fs` are **ESM** (`.js` in a module package);
  on node 24 even `require()` of them works (require-esm), but bench scripts should be
  `.mjs` with `import`.
- `bin/tsc-rs` ships as a Node JS launcher; the postinstall (`node lib/install.js`) rewrites
  it into a sh/JS polyglot that execs the native binary directly. **Our npm's allow-scripts
  policy blocked the postinstall** during install; running `node
  node_modules/tsc-rs/lib/install.js` manually applies it. Measured CLI perf is identical
  either way (~155 ms — native init dominates, the Node launcher costs ~nothing here).
- `--version` prints `Version 7.1.0-dev` (matches `tscVersion` in package.json — the
  TypeScript 7.1 Go-port lineage).
- `unstable/sync` client spawns the binary as a child process and does synchronous RPC over
  pipes, blocking a worker thread with `Atomics.wait` (verified in
  `dist/api/syncChannel.js`). Host-side only, by construction — never bundle into the worker.

### Working invocation (a) — JS API (PREFERRED)

```js
import { API, DiagnosticCategory, formatDiagnostics } from "tsc-rs/unstable/sync";
import { createVirtualFileSystem } from "tsc-rs/unstable/fs";

// Mirrors GUEST_COMPILER_OPTIONS numerically (values verified against
// typescript@6.0.3: target ES2022=9, module ESNext=99, moduleResolution Bundler=100)
const OPTIONS = {
  strict: true, target: 9, noEmit: true, module: 99, moduleResolution: 100,
  skipLibCheck: true, isolatedModules: true, forceConsistentCasingInFileNames: true,
};

// Guest-globals ambient text (repo GUEST_GLOBALS_TEXT) MUST be a rootName,
// exactly like the in-isolate checker's rootNames: [GUEST_GLOBALS, ...guestFiles]
const files = { "/guest-globals.d.ts": GUEST_GLOBALS_TEXT, "/guest.ts": source };

const api = new API({ fs: createVirtualFileSystem(files) });   // spawns native binary, ~2.5ms
const program = api.createProgram(["/guest-globals.d.ts", "/guest.ts"], OPTIONS);
const diags = [
  ...program.getSyntacticDiagnostics("/guest.ts"),
  ...program.getSemanticDiagnostics("/guest.ts"),
]; // DiagnosticResponse[] — see shape below
program.dispose();  // getter → call it
api.close();        // getter → call it (api.dispose() DOES NOT EXIST — TypeError)
```

- **Diagnostic shape** (`DiagnosticResponse`, proto.generated.d.ts): `{code, category
  (number — DiagnosticCategory: Warning=0, **Error=1**, Suggestion=2, Message=3), fileName?,
  pos, end, startPosition?: {line, character} (**zero-based**), endPosition?, source?, text}`
  — `text` is **already flat** (no `messageText` chain; no flattenDiagnosticMessageText
  needed). `formatDiagnostics(diags, api)` renders `guest.ts(1,7): error TS2322: …`
  (1-based, tsc-style).
- **Error surfacing (a):** a diagnostics array + `DiagnosticCategory[d.category] ===
  "Error"`; no exit codes. `program.getProgramDiagnostics()` adds options-level diags.
- **Correctness cross-check vs the in-isolate checker:** slugify-iter1 → exactly 2
  diagnostics, TS2322 `Type 'string' is not assignable to type 'number'` at 2:9 then 3:3 —
  identical to the repo checker's verdict (test-agent-live asserts the same 2-diag/2:9
  shape). Clean snippets (slugify-final, fibonacci-final, lib-heavy, synthetic-100) → 0
  errors. Lib-heavy (`Map` + `Promise.all` + `console`) checks clean under the default lib
  closure.
- **Default lib closure (verified via `program.getSourceFileNames()`):** `lib.es2022.full.d.ts`
  chain **including DOM** (`lib.dom.d.ts`, `lib.dom.iterable.d.ts`, scripthost), loaded from
  `@tsc-rs/linux-arm64/lib/`. The in-isolate checker uses a 115-file es2022 **core**
  closure with **no DOM**. Same verdicts on all five bench snippets either way; footnote it
  in the README table.

### Working invocation (b) — CLI (fallback, verified)

```sh
npx tsc-rs --noEmit --strict --target es2022 --module esnext --skipLibCheck \
  snippet-guest-globals.d.ts snippet-slugify-final.ts
echo $?   # 0 clean, 2 on type errors
```

- No tsconfig required — flags parse tsc-style. `--version` works. Errors print
  `file(line,col): error TSxxxx: text` and exit **2**; clean exits **0**.
- The ambient globals file must be passed as an input file (same rootNames rule as the API).
- **`--skipLibCheck` is required** when the ambient file declares `console`: without it the
  DOM lib's `Console` declaration collides → TS2403 on the globals file itself. (The API leg
  gets skipLibCheck via the mirrored GUEST_COMPILER_OPTIONS; bare CLI probes without it
  will report a spurious error.)
- **Timing: ~155–170 ms median per fresh process** (10 runs: bad.ts 159.8 ms median /
  good.ts 155.8 ms; direct native exec without the Node launcher: 160.3/155.2 ms — process
  + native init + per-process lib load dominates).

### Cold vs warm timing (the README numbers) — 10 runs each, `perf_hooks`

Simple one-file checks (RED = TS2322 snippet, GREEN = clean `export const answer`), fresh
`new API()` per cold sample, 10 warm checks per instance:

| snippet | spawn+init median | cold check median (min) | warm check median (min) |
|---|---|---|---|
| RED (353 B) | 2.5 ms | 34.4 ms (33.3) | 30.8 ms (28.0) |
| GREEN (33 B) | 2.2 ms | 34.6 ms (33.1) | 30.5 ms (28.6) |

Per-bench-snippet (fresh API per snippet, cold = first program, warm = median of 5):

| snippet | bytes | errors (expected) | spawn ms | cold ms | warm median ms |
|---|---|---|---|---|---|
| slugify-iter1 | 353 | 2 (2) OK — TS2322 @ 2:9 | 5.1 | 42.0 | 34.6 |
| slugify-final | 331 | 0 (0) OK | 2.2 | 39.8 | 31.7 |
| fibonacci-final | 361 | 0 (0) OK | 2.2 | 35.8 | 32.2 |
| lib-heavy | 324 | 0 (0) OK | 2.7 | 40.4 | 34.7 |
| synthetic-100 | 5913 | 0 (0) OK | 2.6 | 41.1 | 34.3 |

(CLI cross-check on the same snippets: exit 0/2 as expected, ~155–170 ms each.)

Honest framing for the README: on these small guests, tsc-rs warm (~30–35 ms on this arm64
box) is **not** faster than the in-isolate checker's memoized-lib warm check (8–20 ms,
measured in Phase 2 and live-asserted <2000 ms). The tsc-rs story stays "native today on
the host/agent side, and the `Typechecker` seam drops in when WASM lands" — the table
should present both columns without manufacturing a winner.

### If native had failed

Not applicable — everything ran. Only environment friction: npm's allow-scripts warning on
the tsc-rs postinstall (benign, manual `node lib/install.js` optional) and `/tmp/opencode`
permissions (used `/tmp/tscrs-scratch`).

## Bench Design

`npm run bench:tsc-rs` → `scripts/bench-tsc-rs.mjs` (new devDependency: `tsc-rs@0.2.0`;
host-side only — it must never enter the worker bundle, and `scripts/` is outside `src/`,
so the no-Node-builtins/bundle gates are unaffected).

**One wrinkle to resolve explicitly:** the CONTEXT downstream note says "bench is
host-side only (no wrangler boot needed)", but ROADMAP SC-1 wants a table of *tsc-rs ms vs
in-isolate ms per snippet*, and the in-isolate column per CONTEXT comes from `POST
/typecheck` (5-run median) — which needs the worker. Recommendation: the script boots
`wrangler dev` once on a free port (copy the `freePort`/`spawnWrangler`/`killWrangler`
pattern from scripts/test-agent-live.mjs), runs the in-isolate leg, then the host-side
tsc-rs leg, prints the markdown table, exits nonzero on any mismatch/teardown failure.
Alternative if a boot-free bench is ever wanted: `--in-isolate-url` flag pointing at an
already-running `wrangler dev` (boot when omitted).

### Snippets (the 5, locked)

1. **slugify-iter-1** — exact mock iteration 1 (`src/agent/mock.ts` SLUGIFY turn 1): 353 B,
   planted TS2322 ×2 (`const slug: number`, `return slug`). Expected: 2 errors.
2. **slugify-final** — exact mock iteration 3: 331 B, clean, two `test()` calls.
3. **fibonacci-final** — exact mock FIBONACCI iteration 3: 361 B, clean, two `test()` calls.
4. **lib-heavy** — the `Map`/`Promise.all`/`console` guest already used by
   test-typecheck-live.mjs: 324 B, clean, exercises the default lib closure.
5. **synthetic-100** — ~100-line generated TS (deterministic, in-script): 133 lines /
   5913 B — `interface Item`, `makeItem`/`score`/`topScore`, 30 generated items + a
   `test()` call. Expected: 0 errors.

Define them in the bench script (plain JS strings; do NOT import from `src/agent/mock.ts` —
that graph pulls the provider types and is TS). Duplication is the established harness
pattern (test-agent-live.mjs inlines its own copies already).

### Shared guest surface (both legs, mandatory)

- Ambient file `/guest-globals.d.ts` = repo `GUEST_GLOBALS_TEXT` (test/expect/assert/console
  declarations from src/typecheck/vfs.ts). Without it every mock guest drowns in TS2593
  (`Cannot find name 'test'`) — verified empirically.
- tsc-rs leg: same numeric options as `GUEST_COMPILER_OPTIONS`; in-isolate leg: `POST
  /typecheck {files: {"guest.ts": src}, runs: 6}` — the checker prepends its own globals.

### Table format (README)

```markdown
| snippet          | tsc-rs cold ms | tsc-rs warm med(5) | in-isolate cold ms | in-isolate warm med(5) |
|------------------|----------------|--------------------|--------------------|------------------------|
| slugify-iter1    | …              | …                  | …                  | …                      |
| …                |                |                    |                    |                        |

Machine: linux aarch64, node 24, tsc-rs 0.2.0 (native, "Version 7.1.0-dev"), workerd via
wrangler dev, typescript 6.0.3 in-isolate. Warm med(5) = median of runs 2–6. Footnote:
tsc-rs checks against its default lib closure (es2022.full incl. DOM); the in-isolate
checker uses the bundled es2022 core closure (no DOM). All snippets type-check identically
on both.
```

- `tsc-rs cold` = first `createProgram`+diagnostics on a fresh `new API()` (spawn+init
  measured separately and printed once); `tsc-rs warm med(5)` = median of 5 subsequent
  checks on that instance. Then `api.close()`.
- In-isolate cold = `data.coldMs` (results[0]); warm med(5) = median of
  `data.results.slice(1)` — request `runs: 6` so there are 5 warm samples (the default 5
  gives only 4; `medianMs` as returned includes the cold run).
- Error surfacing per leg (already verified): JS API → diagnostics array (count + category
  filter, no exit code); CLI → exit code 0/2 + stderr line; in-isolate → `results[].ok`.
  The script asserts the expected error counts (2/0/0/0/0) on all legs and fails loudly on
  mismatch — the bench doubles as a semantic regression net for the seam.

## /agent/shell Implementation Shape

New `src/shell.ts` exporting `handleShell(request: Request, env: Env): Promise<Response>`;
index.ts adds `case "POST /agent/shell":` + a `KNOWN_PATHS["/agent/shell"] = "POST"` entry
(405 machinery comes free). index.ts is already 352 lines; a per-area module matches the
repo layout (typecheck/, sandbox/, agent/, runs).

### op → primitive map

| op | args | primitive | result payload |
|---|---|---|---|
| `ls` | — | `Map` keys | `{files: [{name, bytes}]}` |
| `cat` | `{file: string}` | `Map.get` | `{name, content, bytes}` or op-fail `not_found` |
| `write` | `{file, content}` (strings) | `Map.set` (upsert) after total-bytes check | `{name, bytes, totalBytes}` or op-fail `vfs_full` |
| `rm` | `{file: string}` | `Map.delete` | `{name, removed: true}` or op-fail `not_found` |
| `run` | `{file: string}` | `transpileGuest(content)` → syntactic-error gate → `getSandboxRuntime(env).execute(tr.js)` | `{transpileMs, sandbox: ExecuteResult}` or op-fail |
| `typecheck` | — | `getTypechecker().check(rootFilesOfVfs())` | full `TypecheckResult` inline |

- **VFS:** plain per-request `Map<string, string>` — NOT `createVirtualFileSystem` from
  src/typecheck (that builds the typescript CompilerHost; it is an implementation detail of
  the checker). Name normalization identical to `handleTypecheck`/loop `rootFiles`:
  `name.startsWith("/") ? name : "/" + name`. Seeded from optional `files` (same
  validation shape as /typecheck: object, string values, total ≤ cap).
- **run mirrors the loop exactly** (src/agent/loop.ts:267–288 minus the LLM):
  `transpileGuest` → filter `category === "Error"` diags (op result carries them, mirroring
  the loop's tripwire) → `sandbox.execute(tr.js)`. Guardrails are inherited *by
  construction*: deadline interrupt, memory/stack limits, async-usage gate, 20 KiB source
  gate, fresh single-use context, console shim — all inside `QuickJsSandboxRuntime`.
  Limits come from `env` via `getSandboxRuntime(env)` per request, identical to
  /agent/run and /sandbox/execute.
- **typecheck uses the lazy singleton** (`getTypechecker()`): identity flip on /healthz
  applies after the first shell typecheck op, lib memoization warm-up is shared with
  /agent/run — no second 8.8 MB module, no second parse. Empty VFS → op-fail (mirrors
  /typecheck's "at least one entry" rule).

### Request/response schemas

```jsonc
// POST /agent/shell
{
  "commands": [{ "op": "write", "args": { "file": "guest.ts", "content": "…" } },
               { "op": "typecheck" },
               { "op": "run", "args": { "file": "guest.ts" } }],   // 1..32 items
  "files":   { "seed.ts": "…" },      // optional VFS seed (validated like /typecheck files)
  "stopOnError": false                // default false
}
// 200 — per-op results even when ops fail; 400 only for request-shape violations
{
  "ok": true,
  "data": {
    "results": [{ "index": 0, "op": "write", "ok": true, "result": {…}, "ms": 0.1 }, …],
    "halted": false,                   // true iff stopOnError stopped early
    "totalMs": 3.4
  }
}
```

Per-op `ms` via `performance.now()` around just that op (OBS pattern). Everything in
`result` is JSON-serializable by construction (`ExecuteResult` fields are dump'd plain
data; diagnostics are mapped records).

### Validation rules

Request-shape → `400 bad_request` (reuse `parseJsonBody` + `HttpError`):
- `commands` missing / not array / empty / length > 32; element not an object; unknown
  `op`; `cat`/`rm`/`run` without a string `file`; `write` without string `file` AND string
  `content`; seed `files` violations (non-object, non-string value, total > cap).

Op-level → `{ok: false, result: {code: "not_found"|"vfs_full"|"empty"|…, …}}` (never 400):
- `cat`/`rm`/`run` on a missing file → `not_found` (+ available names in detail).
- `write` exceeding the VFS byte cap → `vfs_full`.
- `typecheck` with an empty VFS → `empty`.

### Semantics decisions

- **`ok` on run/typecheck ops:** `op.ok === false` when (a) the op cannot execute
  (not_found / vfs_full / empty), or (b) its outcome failed: `typecheck.ok === false`, or
  `ExecuteResult.status !== "ok"`. Full diagnostics / ExecuteResult still ride inside the
  result — a typecheck failure is the agent's *expected feedback loop*, so the data must
  never be dropped. This gives `stopOnError` its useful meaning: write broken file →
  typecheck op fails → halt before `run` (don't burn a 2 s sandbox deadline on code that
  can't execute).
- **`stopOnError` (default false):** halt before the next op after the first `ok:false`;
  `data.halted = true`; unexecuted ops are simply absent from `results` (`results.length <
  commands.length` is the harness signal).
- **Statelessness:** per-request transient VFS seeded only by `files` (CONTEXT bookkeeping
  decision); nothing shared with agent runs or other requests; runRegistry untouched; the
  loop is unchanged (CONTEXT decision). Two consecutive requests with the same `write` see
  independent VFSes — harness-asserted.

### Caps (hard numbers)

- `MAX_SHELL_COMMANDS = 32` (task cap).
- `MAX_SHELL_VFS_BYTES = 1 MiB` total across all files (enforced on seed + every `write`;
  also the de-facto per-file cap). `run` additionally re-hits the sandbox's own
  `MAX_GUEST_SOURCE_BYTES` (20 KiB) gate — inherited, not duplicated.
- No new timeout: `run` inherits `SANDBOX_TIMEOUT_MS` (default 2 s/op); a 32-command
  request full of `while(true)` runs is bounded by 32 × sandbox deadline, same bound as 32
  /sandbox/execute calls — acceptable for local dev (G10: workerd local dev enforces no
  CPU limits anyway).

### Gates

- `gate:no-host-eval` stays green: the shell adds no eval path — `run` goes through
  `transpileModule` + QuickJS only.
- No vitest spec may import the shell handler: it pulls the typecheck graph (8.8 MB
  typescript crashes the vitest worker transport — Phase 2 lesson). Coverage lives in the
  live harness, like every other worker-graph behavior.

## Harness Additions: scripts/test-shell-live.mjs

Pattern: copy `freePort`/`spawnWrangler`/`killWrangler`/`waitHealthy` from
test-agent-live.mjs (the proven duplicated-harness pattern; detached process group, port
backstop). **One boot** (default env) suffices — shell ops need no env overrides. Leg
order matters for the identity-flip asserts: healthz checks first (both `unloaded`), flip
asserts last.

1. **happy session:** `write` slugify-final → `typecheck` (`ok:true`, `result.ok:true`, 0
   diagnostics) → `run` (`result.sandbox.status === "ok"`, 2 tests, all passed) → `cat`
   roundtrips exact content → `ls` lists `/guest.ts` with byte count → `rm` → `cat` now
   `ok:false` `not_found` → `ls` empty → all op `ms` finite ≥ 0, `totalMs` ≥ sum.
2. **per-request VFS isolation:** second request's `ls` → `[]` (first request's file gone).
3. **typecheck-failure op result:** `write` slugify-iter1 → `typecheck` → op `ok:false`,
   `result.diagnostics.length === 2`, `diagnostics[0]` = `{code: 2322, line: 2, column: 9,
   file: "/guest.ts"}` (same exactness the agent harness asserts) → then the same session
   with `stopOnError: true` and a trailing `run` op: `halted === true`, `results.length ===
   2`, the `run` never executed.
4. **run timeout op result:** `write` `while(true){}` → `run` → op `ok:false`,
   `result.sandbox.status === "timeout"` — and the worker survives (subsequent `ls`
   answers; `wrangler dev` never hangs — the guardrail is the point).
5. **validation 400s:** missing/empty/33 `commands`; unknown op; `write` without
   `content`; `cat` without `file`; malformed JSON; seed `files` with a non-string value;
   seed over 1 MiB. Each → 400 `bad_request`. Plus op-level (200s): `cat`/`rm`/`run`
   not_found; `write` vfs_full (seed a ~1 MiB file, then write one byte more);
   `typecheck` on empty VFS.
6. **write upsert + bytes:** write a file twice → `ls` still one entry, `cat` returns the
   second content, reported `totalBytes` tracks.
7. **identity flips:** after the first typecheck op, `/healthz` `typechecker` flips to
   `typescript@6.0.3 (in-isolate)`; after the first `run` op, `sandbox` flips off
   `unloaded`.
8. **405:** `GET /agent/shell` → 405 with `allow: POST` header (KNOWN_PATHS machinery).

Wire into package.json `test:live` after test-agent-live.mjs (the 5th live harness; ROADMAP
SC-5 says "4 live harnesses" + shell — becomes 5).

## Gotchas

1. **This machine is linux-arm64, not linux-x64** (brief/CONTEXT stale). tsc-rs 0.2.0 ships
   both (`@tsc-rs/linux-arm64` + `@tsc-rs/linux-x64` optionalDeps) — CI/x64 machines are
   fine, but never hardcode the platform package name; use `tsc-rs/unstable/sync` and let
   `getExePath()` resolve.
2. **npm allow-scripts blocks the tsc-rs postinstall** in this environment (bin stays the
   Node JS launcher). Harmless — measured CLI perf identical; `node
   node_modules/tsc-rs/lib/install.js` applies the polyglot rewrite manually if wanted.
3. **Ambient guest-globals file must be a rootName** (API) / an input (CLI), else every
   `test()`/`expect()` guest reports TS2593. The in-isolate checker does this implicitly;
   the tsc-rs leg must do it explicitly.
4. **CLI needs `--skipLibCheck`** when the ambient file declares `console` (DOM lib
   collision → TS2403 on the globals file). API leg inherits it via the mirrored
   GUEST_COMPILER_OPTIONS.
5. **tsc-rs `startPosition` is zero-based** `{line, character}`; the repo's
   `mapDiagnostic` emits one-based line/column. Bench/harness comparisons must not mix
   conventions (compare via code + message, or +1 before comparing to repo diagnostics).
6. **`text` is pre-flattened** — no `messageText` chain, no `flattenDiagnosticMessageText`.
7. **Dispose API quirks:** `program.dispose()` and `api.close()` are getters returning
   functions (call them); `api.dispose` does not exist (TypeError — hit in the first probe
   run). `API` also implements `Symbol.dispose`.
8. **`createVirtualFileSystem` readFile falls through to the real filesystem on
   `undefined`** — that is how the default libs load from `@tsc-rs/linux-arm64/lib/`.
   Return `null` only to say "definitely missing".
9. **Numeric CompilerOptions:** target ES2022=9, module ESNext=99, moduleResolution
   Bundler=100 (verified against typescript@6.0.3 enums) — the tsc-rs API takes plain
   numeric options.
10. **Lib-closure difference:** tsc-rs default = `lib.es2022.full` chain including DOM;
    in-isolate = 115-file es2022 core closure, no DOM. Identical verdicts on all five
    snippets; footnote in the README table rather than forcing lib parity.
11. **Warm tsc-rs ≈ 30–35 ms vs in-isolate warm 8–20 ms** at these snippet sizes: the
    persistent server amortizes little (each `createProgram` re-derives the program).
    Present the table honestly — the native compiler's advantage on 350-byte guests is
    not wall-ms; the video story is the seam, not a win here.
12. **`runs: 6` for the in-isolate warm column** — default 5 yields only 4 warm samples;
    `medianMs` as returned includes the cold run.
13. **Vitest transport rule still applies:** shell handler imports the typecheck graph →
    live-harness coverage only, never a vitest spec.

## Sources

**Empirical (this session, `/tmp/tscrs-scratch`):** `probe.mjs` (API shape, error
surfacing, dispose quirk), `bench.mjs` (10× cold/warm RED+GREEN), `snippets.mjs` (5-snippet
table + CLI cross-check), CLI invocations incl. `--version` (→ `Version 7.1.0-dev`), exit
codes (0/2), `--skipLibCheck` discovery, `getSourceFileNames()` lib-closure dump,
`lib/install.js` polyglot rewrite, require(esm) check.

**tsc-rs 0.2.0 tarball inspection:** `package.json` (exports, optionalDeps, `tscVersion`),
`dist/api/sync/{api,types,client}.d.ts|.js` (API/Program/Snapshot classes,
DiagnosticResponse, Client spawn + SyncRpcChannel + Atomics.wait), `dist/api/options.d.ts`
(ClientSpawnOptions.fs), `dist/api/fs.d.ts` (FileSystem callbacks,
createVirtualFileSystem), `dist/api/proto.generated.d.ts` (DiagnosticResponse fields),
`dist/enums/diagnosticCategory.js` (Error=1), `lib/getExePath.js` (platform resolution),
`@tsc-rs/linux-arm64/lib/` layout (native `tsc` + lib closure).

**Repo:** src/index.ts (route/envelope/validation patterns, KNOWN_PATHS), src/typecheck/
{index.ts — Typechecker seam + singleton, host.ts — GUEST_COMPILER_OPTIONS + makeHost,
vfs.ts — GUEST_GLOBALS_TEXT + memoization, transpile.ts, lib-imports.ts — 115-file no-DOM
closure}, src/sandbox/{runtime.ts — ExecuteResult + guardrails, limits.ts — caps},
src/agent/{loop.ts — run pipeline lines 267–288, mock.ts — exact snippet sources},
scripts/{test-typecheck-live.mjs, test-agent-live.mjs} (harness pattern), wrangler.jsonc,
package.json (scripts).

**Planning:** .planning/ROADMAP.md (milestone v2, Phase 5 SCs), .planning/phases/
05-tsc-rs-agent-shell/05-CONTEXT.md (locked decisions).
