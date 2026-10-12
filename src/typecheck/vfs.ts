import ts from "typescript";
import { LIB_FILES } from "./lib-imports";

// Bare basenames are the map keys: with no `lib` compiler option, typescript
// hands getDefaultLibFileName()'s return value verbatim to getSourceFile(),
// and /// <reference lib> chains also use bare names. Any other key shape
// (absolute paths, "es2022") silently misses the map.
export const LIB_TEXT: ReadonlyMap<string, string> = new Map(Object.entries(LIB_FILES));

// The es2022 closure declares no `console`; guests are contractually allowed
// console.log/error (Phase 3 shims them). Declaration files load only when
// reachable, so this file must stay in every check's rootNames.
export const GUEST_GLOBALS = "/guest-globals.d.ts";
export const GUEST_GLOBALS_TEXT =
  "declare var console: { log(...args: unknown[]): void; error(...args: unknown[]): void; };";

// Lib + globals SourceFiles are immutable pinned text: parse once per
// isolate, reuse across checks (research: 223 ms cold -> 8-20 ms warm). Guest
// SourceFiles are parsed fresh every check — their text changes per
// iteration. Cache holds 58 entries at steady state (57 libs + globals).
const sourceFileCache = new Map<string, ts.SourceFile>();

export function memoSourceFile(
  fileName: string,
  text: string,
  languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
): ts.SourceFile {
  let sf = sourceFileCache.get(fileName);
  if (sf === undefined) {
    sf = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
    sourceFileCache.set(fileName, sf);
  }
  return sf;
}
