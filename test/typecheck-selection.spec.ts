import { describe, expect, it } from "vitest";
import { parseTSChecker } from "../src/typecheck/selection";

// TSCHECKER selection parsing (WASM-03). Pure module — zero imports — so
// this spec never drags either checker graph into the vitest transport.
describe("parseTSChecker", () => {
  it("defaults to ts-js when env is undefined", () => {
    expect(parseTSChecker(undefined)).toBe("ts-js");
  });

  it("defaults to ts-js when TSCHECKER is unset or empty", () => {
    expect(parseTSChecker({})).toBe("ts-js");
    expect(parseTSChecker({ TSCHECKER: "" })).toBe("ts-js");
  });

  it("selects ts-js explicitly", () => {
    expect(parseTSChecker({ TSCHECKER: "ts-js" })).toBe("ts-js");
  });

  it("selects tsc-rs-wasm", () => {
    expect(parseTSChecker({ TSCHECKER: "tsc-rs-wasm" })).toBe("tsc-rs-wasm");
  });

  it("throws on an unknown value", () => {
    expect(() => parseTSChecker({ TSCHECKER: "tsc-rs" })).toThrowError(/TSCHECKER/);
  });
});
