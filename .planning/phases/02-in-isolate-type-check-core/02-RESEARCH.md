# Phase 2 Research: In-isolate type-checking with typescript@6.0.3

**Phase:** 02 — In-isolate type-check core
**Researched:** 2026-10-12 (all findings empirically verified against the registry tarball AND executed inside real workerd via `wrangler dev`)

## Summary

Everything this phase needs is now verified end-to-end inside the actual runtime — not just on paper. I packed `typescript@6.0.3` from the registry (byte-identical to the project's installed copy, sha512-verified), computed the exact lib reference closure, ran a full Map-based-host type-check in Node, then built a throwaway spike worker in `/home/t3code/iso-spike` (generated, 57 lib Text imports + Design-A checker + `POST /typecheck`) and drove it with `wrangler dev` on the project's wrangler@4.149.0 / workerd. Results: **`ts.version === "6.0.3"`, `createProgram` works in-isolate, `process` global is `undefined` (the `no_nodejs_compat` flags hold the `isNodeLikeSystem()` branch closed), a clean 30-line guest checks in 223 ms cold / 8–20 ms warm, and a broken guest returns correct diagnostics with 1-based line:col.** The one MEDIUM-confidence item left by STACK research ("not yet executed inside real workerd") is retired.

**One load-bearing discovery changes the host design in a way CONTEXT.md's notes did not anticipate: do NOT set the `lib` compiler option.** With `lib: ["es2022"]`, 6.0.3 routes lib-option entries through `pathForLibFile()`, which combines the *raw option string* with `getDefaultLibLocation()` (or the directory of `getDefaultLibFileName()`) and resolves extension candidates — it never consults the libMap, so a bare-name VFS map silently serves zero libs and every check drowns in `TS2318 Cannot find global type 'Array'` + `TS2583 Cannot find name 'Promise'` (reproduced; this is the #2 pitfall's exact symptom, with a different root cause than "missing files"). Without the `lib` option, the compiler passes the host's `getDefaultLibFileName()` return value **verbatim** to `getSourceFile()` (verified at typescript.js L127725–127749) — so `getDefaultLibFileName(): "lib.es2022.d.ts"` + that key in the map loads the entire 57-file closure through the `/// <reference lib>` chain. Design A = no `lib` option + bare-name keys; verified both in Node and in workerd (57 lib SourceFiles in every program, zero lib diagnostics).

Second discovery, on the delivery mechanism: wrangler Text rules are **not** esbuild-loader inlining — they are an esbuild plugin (wrangler-dist `module-collection.ts`) that matches the import specifier against the rule globs, reads the file, and ships it as a *separate Text module* with a content-hash name; the bundled `index.js` imports it and workerd hands back the file text as the default export. This works for `**/*.d.ts` globs matching `node_modules/typescript/lib/*` imports — verified end-to-end in workerd (`lib.es5.d.ts` arrived as a 218,972-char string; then 57 of them type-checked a guest). Two config gotchas: a custom `Text` rule without `"fallthrough": true` **silently replaces** wrangler's default `**/*.txt|html|sql` Text rule (parseRules appends defaults after user rules and strips redundant same-type rules), and the libs land outside `index.js`, so the Phase 1 `bundle:check` size gate must count sibling modules, not just the main bundle.

## Verified API Facts (typescript@6.0.3 tarball, `lib/typescript.d.ts` / `lib/typescript.js`)

| Fact | Signature / evidence | Ref |
|---|---|---|
| Version exports | `const versionMajorMinor = "6.0"` (L3653); `const version: string` (L3655) — boot assert `ts.version === "6.0.3"` is valid; also observed live in workerd | d.ts L3653–3655 |
| `createProgram` (object overload) | `createProgram(createProgramOptions: CreateProgramOptions): Program` | d.ts L9614 |
| `createProgram` (classic overload) | `createProgram(rootNames: readonly string[], options: CompilerOptions, host?: CompilerHost, oldProgram?: Program, configFileParsingDiagnostics?: readonly Diagnostic[]): Program` — host is optional but we always pass ours | d.ts L9629 |
| `getPreEmitDiagnostics` | `(program: Program, sourceFile?: SourceFile, cancellationToken?: CancellationToken): readonly Diagnostic[]` — returns syntax + semantic + options + global + config diagnostics; with `noEmit` and no `declaration` there is no emit pipeline, so "pre-emit" = everything relevant | d.ts L9530 |
| `flattenDiagnosticMessageText` | `(diag: string \| DiagnosticMessageChain \| undefined, newLine: string, indent?: number): string` — the chain flattener; handles `next?: DiagnosticMessageChain[]` recursion | d.ts L9534 |
| `getLineAndCharacterOfPosition` | `(sourceFile: SourceFileLike, position: number): LineAndCharacter`; `LineAndCharacter { line /* 0-based */, character /* 0-based */ }` — add 1 for the contract's 1-based output | d.ts L8503, L7192–7196 |
| `Diagnostic` | `{ category, code, file: SourceFile \| undefined, start: number \| undefined, length: number \| undefined, messageText: string \| DiagnosticMessageChain, source?, relatedInformation? }` — `file`/`start` are undefined for global/config diagnostics (e.g. TS2318): the mapper must tolerate that | d.ts L6923–6928, L6930–6937 |
| `DiagnosticCategory` | `Warning = 0, Error = 1, Suggestion = 2, Message = 3` — `ok = diagnostics.every(d => d.category !== Error)`; keep all categories in the payload | d.ts L6940–6945 |
| `CompilerHost` (required members) | `getSourceFile(fileName, languageVersionOrOptions, onError?, shouldCreateNewSourceFile?): SourceFile \| undefined`; `getDefaultLibFileName(options): string`; `writeFile: WriteFileCallback`; `getCurrentDirectory(): string`; `getCanonicalFileName(fileName): string`; `useCaseSensitiveFileNames(): boolean`; `getNewLine(): string` | d.ts L7359–7394 |
| `CompilerHost` (optional members) | `getSourceFileByPath?`, `getCancellationToken?`, **`getDefaultLibLocation?`**, `readDirectory?`, `resolveModuleNames?` (+ newer `resolveModuleNameLiterals?`), `resolveTypeReferenceDirectives?`(+References), `getModuleResolutionCache?`, `getEnvironmentVariable?`, `hasInvalidatedResolutions?`, `createHash?`, `getParsedCommandLine?`, `jsDocParsingMode?` — none needed for Design A | d.ts L7359–7394 |
| Inherited from `ModuleResolutionHost` | **required**: `fileExists(fileName): boolean`, `readFile(fileName): string \| undefined`; optional: `trace?`, `directoryExists?`, `realpath?`, `getCurrentDirectory?`, **`getDirectories?(path): string[]`** (note: optional, lives here, not on CompilerHost), `useCaseSensitiveFileNames?` | d.ts L7260–7275 |
| `getDefaultLibFileName` is a bare name | With no `lib` option: `processRootFile(getDefaultLibraryFileName(), ...)` passes the host's return value **verbatim** to `getSourceFile` — observed request log: `getSourceFile("lib.es2022.d.ts")` (this is microsoft/TypeScript#35318; we own the name, so the map hits) | ts.js L127737–127741 |
| `lib` option path (avoid) | With `options.lib`: `forEach(options.lib, (libFileName, i) => processRootFile(pathForLibFile(libFileName), ...))`; `pathForLibFileWorker` → `actual = combinePaths(defaultLibraryPath, libFileName)` — raw option string ("es2022", no libMap lookup) + location prefix + `.ts/.tsx/.d.ts` candidate resolution. Observed requests: `getSourceFile("/ts-libs/es2022.ts")`, `"...es2022.tsx")`, `"...es2022.d.ts")`. Serving bare-name keys here = 0 libs, TS2318 storm (reproduced). `libReplacement` option exists, default `false` (d.ts "defaultValueDescription: false"; ts.js L41422) | ts.js L127743–127749, L129392–129415 |
| `isNodeLikeSystem()` guard | `return typeof process !== "undefined" && !!process.nextTick && !process.browser && typeof require !== "undefined"` — three independent false conditions under `no_nodejs_compat`; workerd spike observed `typeof process === "undefined"` | ts.js L3772–3774 |
| `createSourceFile` | `(fileName, sourceText, languageVersionOrOptions: ScriptTarget \| CreateSourceFileOptions, setParentNodes?: boolean, scriptKind?): SourceFile` — memoization entry point | d.ts L9202 |
| `transpileModule` (Phase 3 seam) | `(input: string, transpileOptions: TranspileOptions): TranspileOutput` — same package serves the JS output; no extra dep | d.ts L11408 |

## Lib Set (exact)

**Decision: bundle the complete `lib.es2022.d.ts` reference closure — 57 files, 458.9 KB raw text. No DOM, no webworker, no `.full` variants.** The closure is computed from `/// <reference lib="…" />` chains (each entry file is tiny; `lib.es5.d.ts` is the only heavy one). Verified complete: a `lib`-free program with these 57 keys produced **zero** lib-file diagnostics and resolved `Promise`, `Map`, `Array.prototype.reduce`, `toFixed`, spread, `Math` — including a strict-mode semantic error probe (TS2365) as a positive control.

Closure (reference order from `lib.es2022.d.ts`, files as they must appear as VFS map keys):

- **Chain heads (byte-size ≈1 KB each):** `lib.es2022.d.ts` ← refs `es2021`, `es2022.array`, `es2022.error`, `es2022.intl`, `es2022.object`, `es2022.regexp`, `es2022.string`; each `es20XX.d.ts` steps down to `es2015` → `es5`
- **Heavy hitters:** `lib.es5.d.ts` 213.8 KB · `lib.es2020.bigint.d.ts` 37.4 KB · `lib.es2015.core.d.ts` 22.3 KB · `lib.es2020.intl.d.ts` 21.9 KB · `lib.es2015.iterable.d.ts` 17.8 KB · `lib.decorators.d.ts` 12.8 KB (referenced by es5) · `lib.es2015.symbol.wellknown.d.ts` 10.7 KB · `lib.es2021.intl.d.ts` 8.0 KB · `lib.es2022.intl.d.ts` 7.5 KB · `lib.es2017.sharedmemory.d.ts` 7.0 KB · `lib.es2015.reflect.d.ts` 6.3 KB
- **Remaining 46 files:** all ≤ 5.2 KB (es2015.collection/proxy/promise/generator/symbol, es2016.array.include/intl, es2017.{arraybuffer,date,intl,object,string,typedarrays}, es2018.{asynciterable,asyncgenerator,promise,regexp,intl}, es2019.{array,object,string,symbol,intl}, es2020.{date,number,promise,sharedmemory,string,symbol.wellknown}, es2021.{promise,string,weakref}, es2022.{array,error,object,regexp,string}, `lib.decorators.legacy.d.ts`)
- **Total: 458.9 KB / 57 files**

**Guest tsconfig options (the `compilerOptions` we hand to `createProgram`):**

```ts
{
  strict: true,            // catches the agent-facing errors the loop fixes
  target: ts.ScriptTarget.ES2022,
  // NO `lib` option — see Summary. Its presence reroutes lib acquisition away
  // from getDefaultLibFileName and silently yields zero libs (TS2318 storm).
  noEmit: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, // inert in-memory (no imports in guests), sane if one appears
  skipLibCheck: true,      // libs are fixed text; don't re-verify them per check
  isolatedModules: true,   // guests must be transpileModule-safe anyway (Phase 3)
  forceConsistentCasingInFileNames: true,
}
```

**Guest globals:** the es2022 closure contains **no `console` declaration** (verified by grep across all 57 files). Guests are contractually allowed `console.log/error` (Phase 3 shims it), so ship a hand-written `guest-globals.d.ts` in the VFS and **include it in `rootNames`** (declaration files are only loaded if reachable — unreferenced VFS entries are invisible):

```ts
const GUEST_GLOBALS = "/guest-globals.d.ts";
const GUEST_GLOBALS_TEXT =
  "declare var console: { log(...args: unknown[]): void; error(...args: unknown[]): void; };";
// rootNames: [GUEST_GLOBALS, ...guestFileNames]
```

Verified in workerd: with the globals file in rootNames, a `console.log/error` + strict-types guest yields 0 diagnostics; without it, two TS2584s.

## Recommended Implementation

### VFS + host skeleton (Design A — verified in workerd, ~40 lines)

```ts
import ts from "typescript";
// One import per lib file (57 total) — wrangler Text rule ships each as a module:
import libEs2022 from "typescript/lib/lib.es2022.d.ts";
import libEs5 from "typescript/lib/lib.es5.d.ts";
// ... generated list; every key is the bare basename the compiler will request
const LIB_TEXT = new Map<string, string>([
  ["lib.es2022.d.ts", libEs2022],
  ["lib.es5.d.ts", libEs5],
  /* ...55 more... */
]);

// Memoized lib SourceFiles — the phase's latency/memory lever (CONTEXT: "memoized").
// 57 files parsed once per isolate; every later check reuses them.
const sourceFileCache = new Map<string, ts.SourceFile>();
function memoSourceFile(fileName: string, text: string, lv: ts.ScriptTarget): ts.SourceFile {
  let sf = sourceFileCache.get(fileName);
  if (!sf) { sf = ts.createSourceFile(fileName, text, lv, true); sourceFileCache.set(fileName, sf); }
  return sf;
}

function makeHost(guestFiles: Map<string, string>): ts.CompilerHost {
  return {
    getSourceFile(fileName, languageVersionOrOptions) {
      if (fileName === GUEST_GLOBALS) return memoSourceFile(fileName, GUEST_GLOBALS_TEXT, languageVersionOrOptions);
      if (LIB_TEXT.has(fileName)) return memoSourceFile(fileName, LIB_TEXT.get(fileName)!, languageVersionOrOptions);
      const text = guestFiles.get(fileName);          // guest: parsed fresh per check
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
    },
    getDefaultLibFileName: () => "lib.es2022.d.ts",   // MUST be a key in LIB_TEXT
    writeFile: () => {},                              // noEmit: discard
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (f) => f === GUEST_GLOBALS || LIB_TEXT.has(f) || guestFiles.has(f),
    readFile: (f) => LIB_TEXT.get(f) ?? guestFiles.get(f),
    readDirectory: () => [],
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
}

function check(files: Map<string, string>) {
  const host = makeHost(files);
  const t0 = performance.now();
  const program = ts.createProgram({ rootNames: [GUEST_GLOBALS, ...files.keys()], options: compilerOptions, host });
  const diags = ts.getPreEmitDiagnostics(program);
  return { ms: performance.now() - t0, diagnostics: diags.map(mapDiagnostic) };
}
```

`import ts from "typescript"` (default import, UMD interop) is verified working under wrangler bundling in workerd (`typeofCreateProgram: "function"` from the live spike).

### Diagnostics mapper (contract shape, 1-based, sorted)

```ts
function mapDiagnostic(d: ts.Diagnostic): TypecheckDiagnostic {
  const loc = d.file !== undefined && d.start !== undefined
    ? ts.getLineAndCharacterOfPosition(d.file, d.start)   // 0-based
    : { line: -1, character: -1 };                         // global/config diags have no file
  return {
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"), // flattens chain.next[]
    line: loc.line + 1,
    column: loc.character + 1,
    file: d.file?.fileName ?? "(program)",
    category: ts.DiagnosticCategory[d.category],          // keep warnings in payload
  };
}
// sort: (file, line, column); ok = diagnostics.every(d => d.category !== "Error")
```

Chain flattening verified live: `Cannot find module './nope'…` (TS2307) and the multi-line `Promise<string> is not assignable… Type 'string'…` (TS2322 with a `next` chain) both flatten to single strings with `\n` separators. Do NOT filter warnings/suggestions out of the payload — compute `ok` from errors only (CONTEXT decision) and let the LLM see everything; DO treat diagnostics whose `file` starts with `lib.` as a host bug (there should be none — libs come from our map; verified zero across all probes).

### Text-rule import pattern (primary) + robust fallback

**wrangler.jsonc (append to Phase 1 config):**

```jsonc
"rules": [
  {
    "type": "Text",
    "globs": ["**/*.d.ts"],
    "fallthrough": true   // REQUIRED: without it the DEFAULT **/*.txt|html|sql
                          // Text rule is silently dropped (verified: wrangler
                          // warns and parseRules removes the default rule)
  }
]
```

```ts
// 57 generated imports — specifier hits the glob, plugin ships a hash-named
// Text module, workerd serves the file text as the default export (verified).
import libEs5 from "typescript/lib/lib.es5.d.ts";
```

Mechanics verified by source + dry-run + live curl: wrangler's module-collector esbuild plugin matches the *import specifier* against the glob, records a `<sha1>-lib.es5.d.ts` sibling module, rewrites the import external, and `wrangler dev`/`deploy` ship it; `default` = file text. Dry-run output for the full spike: `index.js` ~11 MB (typescript.js) + 57 sibling lib modules; **Total Upload 11,242.62 KiB / gzip 1,776.67 KiB** — far under the 64 MiB cap, but `bundle:check` should assert on the printed "Total Upload" line (main bundle alone will look ~40 KB lighter than reality).

**Robust fallback (only if a future wrangler regresses on `.d.ts` matching):** copy the 57 files to `src/vendor-libs/lib.*.d.ts.txt` via a generation script and import them — `**/*.txt` is Text *by wrangler's default rules* (verified in wrangler-dist `DEFAULT_MODULE_RULES`), zero config, and `.txt` sidesteps any `.d.ts`-as-TypeScript ambiguity in bundlers. Cost: 459 KB duplicated source that must be regenerated when the pin changes (boot assert catches drift). Not needed today — the direct `node_modules` import is the recommended path, verified green in workerd.

Also verified negative (don't bother): there is no need for `getDefaultLibLocation()` in Design A (it's optional; only the `lib`-option path uses it), and no need for esbuild loader overrides.

### Boot assert (runs at lazy-init, before first check)

```ts
function assertCompilerIdentity(): void {
  if (ts.version !== "6.0.3") {
    throw new Error(
      `FATAL: in-isolate typechecker requires exactly typescript@6.0.3 (pure-JS line); ` +
      `loaded "${ts.version}". npm "latest" (7.x) is the NATIVE tsgo build and cannot run in workerd.`,
    );
  }
  if (typeof ts.createProgram !== "function" || typeof ts.getPreEmitDiagnostics !== "function") {
    throw new Error("FATAL: typescript createProgram/getPreEmitDiagnostics missing — API shape changed");
  }
  if (typeof (globalThis as Record<string, unknown>).process !== "undefined") {
    throw new Error("FATAL: process global present — no_nodejs_compat flags lost; isNodeLikeSystem() would take the Node branch");
  }
}
```

`version` is a live string export (d.ts L3655, observed `"6.0.3"` from inside workerd). The `process` check is cheap insurance for the Phase 1 flags contract (Phase 1 research: both `no_nodejs_compat*` flags required at compat date ≥ 2026-08-04). `/healthz`'s `typechecker` field flips to `typescript@6.0.3 (in-isolate)` after lazy init via the existing `getRuntimeInfo()` seam in src/index.ts:79.

### Performance expectation (first-party, measured in workerd)

| Measurement | Value | Where |
|---|---|---|
| First check (cold): parse 57 libs + globals + 30-line guest + full program + diagnostics | **223 ms** | live `wrangler dev` workerd spike, `GET /boot` |
| Warm checks (lib+globals SourceFiles memoized, fresh program per check) | **8–20 ms** (runs: 20.0, 9.0, 10.0, 8.0, 12.0) | live workerd, `POST /typecheck {runs:5}` |
| Broken-guest warm check (4 errors, chain-flattened) | 30 ms | live workerd |
| Same shape in plain Node (reference): cold / warm | 69–143 ms / 15–28 ms | /tmp spike, node v24 |
| Cache at steady state | 58 SourceFiles (57 libs + guest-globals) | `sourceFileCache.size` |

This confirms the phase's timing-fidelity assumption (numbers are non-zero, second ≤ first, `performance.now()` advances across the check inside workerd) and the CONTEXT memoization strategy (warm ≈ 25–30× cold). External "TS playground cold 200–800 ms" folklore is consistent with our cold number but no authoritative citable source was found — mark LOW confidence; our own workerd numbers above are the anchor. Phase 4's N-run `/typecheck` stats will sit on warm checks (~10 ms/run → N=20 is ~200 ms, trivially inside a request).

## Gotchas (phase-specific)

1. **Never set the `lib` compiler option.** It reroutes lib acquisition through `pathForLibFile()` → `combinePaths(defaultLibraryPath, <raw option string>)` + extension-candidate resolution, bypassing both `libMap` and `getDefaultLibFileName` — with a Map host this silently yields zero lib files and a TS2318/TS2583 storm on every check (reproduced in Node and seen in workerd). With no `lib` option, `getDefaultLibFileName()`'s return goes verbatim to `getSourceFile` — that's the only path a bare-name VFS map can serve. This is the phase's #1 integration trap; a wrong implementation here *type-checks nothing and still returns diagnostics*, so it looks half-working.
2. **`fallthrough: true` on the custom Text rule** — a `Text` rule without it replaces the default `**/*.txt|html|sql` handling (wrangler prints a warning; phase 3+ assets using `.txt` would then bundle as empty JS). Verified in wrangler-dist `parseRules` + live dry-run warning.
3. **`console` is not in the es2022 closure** — ship `guest-globals.d.ts` and put it in `rootNames`, or every `console.log` in a guest becomes TS2584 noise fed to the LLM (verified both ways).
4. **Declaration files must be reachable** — an unreferenced `.d.ts` sitting in the VFS map does nothing; `rootNames` is how the globals file gets pulled in.
5. **TS2318-style diagnostics have `file: undefined`** (`start` too) — the mapper must tolerate missing file/start before calling `getLineAndCharacterOfPosition`, and any lib-file diagnostic at all means the host is broken (fix the map, don't filter — PITFALLS.md's rule, reaffirmed: zero lib diags observed across all verified probes).
6. **Text-rule modules are siblings, not inlined** — `index.js` alone understates bundle size by ~459 KB of libs; gate `bundle:check` on wrangler's "Total Upload" line (11.24 MB total measured, 1.78 MB gzip). Also expect 57 extra files in any `--outdir` dry-run output.
7. **Memoize by exact key, parse guests fresh.** `getSourceFile` receives bare names for the default lib but absolute-ish names for guests (`"/guest.ts"` from `rootNames`) — keep guest paths rooted (`/guest.ts`) and lib keys bare; mixing conventions is how the map "randomly" misses. Memoize only lib+globals SourceFiles (they're immutable); guest SourceFiles must be re-created per check (files change every iteration).
8. **`skipLibCheck: true` is load-bearing for warm-check latency** — without it the checker re-validates 459 KB of declaration text every program. Keep it on; the libs are pinned text, their correctness is a build-time concern, not a per-check one.
9. **`isolatedModules: true` on the guest check** surfaces transpile-unsafe constructs (const enums, etc.) at type-check time — exactly what Phase 3's `transpileModule` path needs; verified no false positives on normal guests.
10. **`getDirectories`/`readDirectory` are optional** — provide trivial stubs (`[]`) for hygiene; resolution never consults them for in-map files (verified: full programs build without them being called with meaningful args).
11. **`pkill -f wrangler` kills the shell running it** (argv self-match) when scripting dev-server cleanup in tests — use port-scoped patterns or a PID file; relevant to the curl-based integration tests this phase adds.
12. **Spike cleanup debt:** the verification worker still runs nothing now (dev server stopped; scratch lives in `/home/t3code/iso-spike` and `/tmp/ts603` outside the repo). The repo itself was not modified.

## Sources

| Source | Confidence | Notes |
|---|---|---|
| typescript@6.0.3 registry tarball, `lib/typescript.d.ts` + `lib/typescript.js` (packed to /tmp/ts603, sha512-matched to project `node_modules` copy) | HIGH | Every signature/line ref in "Verified API Facts"; `isNodeLikeSystem` at ts.js L3772; `lib`-option vs default-lib acquisition branches at ts.js L127725–127749 & L129392–129415; `libReplacement` default false; `version` exports L3653–3655 |
| Node execution spike (/tmp/ts603: Map host, es2022 closure, memoized SourceFiles, diagnostics probes) | HIGH | Design A fully green (57 libs, clean guest, correct TS2322/2304/2583/2365/2307/2584 probes); Design B failure reproduced (0 libs via `lib` option); chain flattening + 1-based mapping verified |
| **In-workerd execution spike** (`wrangler dev` @ 4.149.0 on generated /home/t3code/iso-spike worker: 57 Text imports + full checker + `POST /typecheck`) | HIGH | `ts.version "6.0.3"`, `createProgram` function, `process` undefined, cold 223 ms, warm 8–20 ms, correct 1-based diagnostics, cache 58 — retires STACK.md's "not yet executed inside real workerd" MEDIUM |
| wrangler@4.149.0 dist source (`wrangler-dist/cli.js`: `parseRules`, `DEFAULT_MODULE_RULES`, `createModuleCollector`) | HIGH | Rule→module mechanics (plugin onResolve → hash-named sibling Text module, default export = text); default Text rule `**/*.txt,html,sql`; redundant-rule-without-fallthrough removal logic |
| wrangler dry-run + live curl of Text-rule worker | HIGH | `**/*.d.ts` glob matches node_modules import specifiers; bundle layout (index.js + 57 siblings); Total Upload 11,242.62 KiB / gzip 1,776.67 KiB; fallthrough warning text captured verbatim |
| Project research (STACK.md, PITFALLS.md, 01-RESEARCH.md) + phase CONTEXT.md | HIGH | Pin rationale (7.x native), TS#35318 semantics, no_nodejs_compat flags, healthz seam — re-verified where load-bearing (bare-name getDefaultLibFileName behavior confirmed live) |
| "TS playground ~200–800 ms cold" folklore | LOW | No authoritative citable source found; superseded by first-party workerd measurements above |
