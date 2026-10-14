// Guest-side assertion harness (03-RESEARCH): injected as SOURCE in a first
// evalCode — NOT as host functions — because context.throw() from a host
// function does not propagate into the guest call stack (a host-function
// harness silently recorded a failing assertion as PASSED).
//
// v5 H5: the test records are a CLOSURE-PRIVATE array, never a guest global.
// The old implementation kept them in a writable `globalThis.__tests`, so a
// guest could clear the evidence or push fabricated passes; the loop trusted
// whatever it read back. Now the ONLY host-side reference to the records is
// the eval completion value — a retained QuickJS handle the guest cannot
// reach — and the harness functions are locked in place
// (writable/configurable: false), so strict-mode guests that try to replace
// test/expect/assert throw instead of quietly feeding the loop fake results.
//
// makeHarness is deliberately SELF-CONTAINED (no references outside its own
// body) so HARNESS_SOURCE can be its exact stringified form: the runtime
// evals `(makeHarness)(globalThis)` and the completion value IS the private
// records array. Specs exercise makeHarness directly (no dynamic codegen —
// workerd forbids it), and the live sandbox harness proves the SOURCE path
// end-to-end in real QuickJS.
export interface HarnessRecord {
  name: string;
  passed: boolean;
  error?: string;
}

export function makeHarness(globalObject: object): HarnessRecord[] {
  const records: HarnessRecord[] = [];
  const isNaNValue = function (value: unknown): boolean {
    return typeof value === "number" && value !== value;
  };
  // H6: structural equality without JSON-stringify's pitfalls — NaN never
  // equals anything (not even NaN), undefined !== a function, arrays and
  // plain objects compare recursively, functions only by reference.
  const deepEqual = function (a: unknown, b: unknown): boolean {
    if (isNaNValue(a) || isNaNValue(b)) {
      return false;
    }
    if (a === b) {
      return true;
    }
    if (a === null || b === null) {
      return false;
    }
    if (typeof a !== typeof b) {
      return false;
    }
    if (typeof a !== "object") {
      return false;
    }
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const aIsArray = Array.isArray(objA);
    if (aIsArray !== Array.isArray(objB)) {
      return false;
    }
    if (aIsArray) {
      const arrA = a as unknown[];
      const arrB = b as unknown[];
      if (arrA.length !== arrB.length) {
        return false;
      }
      for (let i = 0; i < arrA.length; i++) {
        if (!deepEqual(arrA[i], arrB[i])) {
          return false;
        }
      }
      return true;
    }
    const keysA = Object.keys(objA);
    const keysB = Object.keys(objB);
    if (keysA.length !== keysB.length) {
      return false;
    }
    for (let j = 0; j < keysA.length; j++) {
      const key = keysA[j];
      if (!Object.prototype.hasOwnProperty.call(objB, key)) {
        return false;
      }
      if (!deepEqual(objA[key], objB[key])) {
        return false;
      }
    }
    return true;
  };
  const shown = function (value: unknown): string {
    try {
      const text = JSON.stringify(value);
      return text === undefined ? String(value) : text;
    } catch (e) {
      return String(value);
    }
  };
  const testFn = function (name: unknown, fn: () => void): void {
    try {
      fn();
      records.push({ name: String(name), passed: true });
    } catch (e) {
      const err = e as { name?: unknown; message?: unknown };
      records.push({
        name: String(name),
        passed: false,
        error:
          err && err.name !== undefined
            ? String(err.name) + ": " + String(err.message)
            : String(e),
      });
    }
  };
  const expectFn = function (actual: unknown) {
    return {
      toEqual: function (expected: unknown): void {
        if (!deepEqual(actual, expected)) {
          throw new Error("expected " + shown(expected) + ", got " + shown(actual));
        }
      },
      toBeTrue: function (msg?: string): void {
        if (actual !== true) {
          throw new Error(msg === undefined ? "expected true, got " + shown(actual) : msg);
        }
      },
      // H6: validates finite number operands and a non-negative finite
      // tolerance — the old `NaN > tolerance` comparison silently PASSED
      // for NaN actuals (and NaN - 42 > tol is false the other way too).
      toBeCloseTo: function (expected: number, eps?: number): void {
        const tolerance = eps === undefined ? 1e-6 : eps;
        if (
          typeof actual !== "number" ||
          !isFinite(actual) ||
          typeof expected !== "number" ||
          !isFinite(expected)
        ) {
          throw new Error(
            "toBeCloseTo needs finite numbers, got " + shown(actual) + " vs " + shown(expected),
          );
        }
        if (typeof tolerance !== "number" || !isFinite(tolerance) || tolerance < 0) {
          throw new Error(
            "toBeCloseTo tolerance must be a non-negative finite number, got " + shown(tolerance),
          );
        }
        if (Math.abs(actual - expected) > tolerance) {
          throw new Error("expected ~" + expected + ", got " + actual);
        }
      },
    };
  };
  const assertFn = function (cond: unknown, msg?: string): void {
    if (!cond) {
      throw new Error(msg === undefined ? "assertion failed" : msg);
    }
  };
  const lock = function (name: string, fn: unknown): void {
    Object.defineProperty(globalObject, name, {
      value: fn,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  };
  lock("test", testFn);
  lock("expect", expectFn);
  lock("assert", assertFn);
  return records;
}

export const HARNESS_SOURCE = `(${makeHarness})(globalThis);`;
