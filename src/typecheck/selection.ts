// TSCHECKER env selection (WASM-03): pure parsing, zero imports, so vitest
// specs exercise it without pulling in either checker graph (typescript
// 8.8 MB or the 5.1 MB wasm module — the Phase 2 transport lesson).
export type TSCheckerSelection = "ts-js" | "tsc-rs-wasm";

export function parseTSChecker(env?: { TSCHECKER?: string }): TSCheckerSelection {
  const raw = env?.TSCHECKER;
  if (raw === undefined || raw === "" || raw === "ts-js") return "ts-js";
  if (raw === "tsc-rs-wasm") return "tsc-rs-wasm";
  throw new Error(`TSCHECKER must be "ts-js" or "tsc-rs-wasm"; got "${raw}"`);
}
