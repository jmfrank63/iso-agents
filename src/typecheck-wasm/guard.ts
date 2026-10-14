// Guest file validation for the tsc-rs-wasm checker (v5 H1/H2): a PURE
// module — zero imports — so vitest specs exercise it without dragging the
// 5.1 MB wasm module into the worker transport (Phase 2 lesson). The guard
// runs twice by design: the HTTP layer (/typecheck) calls it for an early
// 400 bad_request, and the checker's seed calls it again so no entry point
// (agent loop, /agent/shell) can bypass it.

// Repo-rooted canonical form for a submitted path — identical rooting to
// the HTTP layer and the loop's rootFiles: bare names gain a leading "/".
export function canonicalGuestPath(name: string): string {
  return name.startsWith("/") ? name : `/${name}`;
}

// Only TypeScript sources may enter the check project. ".d.ts" ends in
// ".ts", so ambient declarations pass; everything else (tsconfig.json,
// .txt, extensionless) is rejected — a non-source file can only confuse
// the checker, never help the guest.
export function isGuestSourcePath(canonical: string): boolean {
  return canonical.endsWith(".ts");
}

export class GuestFileError extends Error {}

// H1: throws GuestFileError on a non-.ts/.d.ts path; returns the
// canonicalized name so callers seed exactly what was validated.
export function assertValidGuestFile(name: string): string {
  const canonical = canonicalGuestPath(name);
  if (!isGuestSourcePath(canonical)) {
    throw new GuestFileError(`guest file ${canonical} must be a .ts or .d.ts source file`);
  }
  return canonical;
}
