// Guest-side assertion harness (03-RESEARCH): injected as SOURCE in a first
// evalCode — NOT as host functions — because context.throw() from a host
// function does not propagate into the guest call stack (a host-function
// harness silently recorded a failing assertion as PASSED). test(name, fn)
// runs fn immediately at registration and records {name, passed, error?};
// the runtime reads the __tests global after the guest eval. Deliberately
// plain strings (no template literals inside) so this file stays one big
// template literal.
export const HARNESS_SOURCE = `globalThis.__tests = [];
globalThis.test = function (name, fn) {
  try {
    fn();
    globalThis.__tests.push({ name: name, passed: true });
  } catch (e) {
    globalThis.__tests.push({
      name: name,
      passed: false,
      error: e && e.name !== undefined ? e.name + ": " + e.message : String(e),
    });
  }
};
globalThis.expect = function (actual) {
  return {
    toEqual: function (expected) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error("expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
      }
    },
    toBeTrue: function (msg) {
      if (actual !== true) {
        throw new Error(msg === undefined ? "expected true, got " + JSON.stringify(actual) : msg);
      }
    },
    toBeCloseTo: function (expected, eps) {
      const tolerance = eps === undefined ? 1e-6 : eps;
      if (Math.abs(actual - expected) > tolerance) {
        throw new Error("expected ~" + expected + ", got " + actual);
      }
    },
  };
};
globalThis.assert = function (cond, msg) {
  if (!cond) {
    throw new Error(msg === undefined ? "assertion failed" : msg);
  }
};`;
