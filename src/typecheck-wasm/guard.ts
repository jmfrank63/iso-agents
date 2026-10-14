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

// H2: compiler-owned paths. The checker seeds /app/tsconfig.json (project
// config — a guest copy like {"noCheck":true} used to overwrite it and buy
// a clean verdict with zero checking) and /app/guest-globals.d.ts (trusted
// ambient declarations — a guest file of the same name used to be silently
// shadowed by the trusted seed and never checked). Canonical repo-rooted
// names: the checker roots every submitted path by exactly this function.
export const RESERVED_GUEST_PATHS: ReadonlySet<string> = new Set([
  "/tsconfig.json",
  "/guest-globals.d.ts",
]);

// H1+H2: throws GuestFileError on a non-.ts/.d.ts path or a compiler-owned
// name; returns the canonicalized name so callers seed exactly what was
// validated.
export function assertValidGuestFile(name: string): string {
  const canonical = canonicalGuestPath(name);
  if (!isGuestSourcePath(canonical)) {
    throw new GuestFileError(`guest file ${canonical} must be a .ts or .d.ts source file`);
  }
  if (RESERVED_GUEST_PATHS.has(canonical)) {
    throw new GuestFileError(`guest file ${canonical} collides with a compiler-owned path`);
  }
  return canonical;
}
