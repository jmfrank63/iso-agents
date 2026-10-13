// Live in-workerd verification harness for the Phase 6 tsc-rs-wasm checker
// (TSCHECKER=tsc-rs-wasm boot; fifth leg of `npm run test:live`).
//
// ONE `wrangler dev` boot with `--var TSCHECKER:tsc-rs-wasm` (the proven
// test-agent-live.mjs pattern — spawn-env vars never reach the worker, so
// per-boot vars ride the documented --var flag). Leg ORDER matters for the
// lazy-identity asserts: the /healthz "unloaded" preflight comes FIRST, the
// identity flip to the ts-rs pin comes LAST.
//
// The default (ts-js) mode is unchanged and stays covered by the other four
// harnesses; this file proves the wasm-mode leg of WASM-05's "both modes"
// gate: green/red/lib guests over /typecheck (stats shape), EXACT
// diagnostics (code/line/column) via the /agent/shell typecheck op (the
// /typecheck endpoint returns stats only — per-diagnostic exactness was
// re-homed in Phase 4), the agent loop converging over the selected checker
// (factory routing, zero call-site changes), and the flip.
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:net";

const failures = [];
function assert(cond, label, detail) {
  if (cond) {
    console.log(`ok - ${label}`);
  } else {
    failures.push(label);
    console.error(`FAIL - ${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  }
}

const GREEN = "export const answer: number = 42;\n";
const RED = 'const n: number = "not a number";\nconsole.log(n);\n';
const SLUGIFY_ITER1 = `function slugify(input: string): string {
  const slug: number = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug;
}
test("lowercases and hyphenates", () => { expect(slugify("Hello World")).toEqual("hello-world"); });
test("trims and collapses separators", () => { expect(slugify("  A -- B  ")).toEqual("a-b"); });
`;
const LIB_GUEST = `
const pairs: Array<[string, number]> = [["a", 1], ["b", 2]];
const m = new Map<string, number>(pairs);
export async function total(): Promise<number> {
  console.log("count", m.size);
  console.error("summing");
  const parts = await Promise.all([...m.values()]);
  return parts.reduce((acc, v) => acc + v, 0);
}
`;

// Exact mock task/spec (scripts/test-agent-live.mjs): the mock converges to
// success in exactly 3 iterations — broken types (iter1) -> logic-broken
// (iter2) -> green (iter3) — now with the WASM checker gating each step.
const SLUG_TASK = "Implement a slugify function";
const SLUG_SPEC =
  "slugify(input: string): string — lowercase, trim, collapse runs of non-alphanumerics into single hyphens, strip leading/trailing hyphens. 'Hello World' -> 'hello-world'; '  A -- B  ' -> 'a-b'.";

// Mock iteration 3 (clean slugify) for the shell typecheck op.
const SLUGIFY_FINAL = `function slugify(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
test("lowercases and hyphenates", () => { expect(slugify("Hello World")).toEqual("hello-world"); });
test("trims and collapses separators", () => { expect(slugify("  A -- B  ")).toEqual("a-b"); });
`;

let port;

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const chosen = srv.address().port;
      srv.close(() => resolve(chosen));
    });
    srv.on("error", reject);
  });
}

async function get(path, { method = "GET", body, headers } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(30000), // wasm checks cost ~0.6-1.2 s per run (06-RESEARCH)
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null; // non-JSON body
  }
  return { status: res.status, headers: res.headers, json };
}

function post(path, bodyText) {
  return get(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyText,
  });
}

async function waitHealthy(getLog) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return { status: res.status, json: await res.json() };
    } catch {
      // not up yet
    }
  }
  throw new Error(`wrangler dev did not serve /healthz within 60s. Log tail:\n${getLog().slice(-2000)}`);
}

function spawnWrangler(vars) {
  const varFlags = Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]);
  return spawn("wrangler", ["dev", "--port", String(port), ...varFlags], {
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group so teardown kills wrangler + workerd together
  });
}

async function killWrangler() {
  if (wrangler !== undefined && wrangler.pid !== undefined) {
    try {
      process.kill(-wrangler.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (port !== undefined) {
    await new Promise((r) => setTimeout(r, 2000));
    let stillUp = true;
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    } catch {
      stillUp = false; // down — good
    }
    if (stillUp) {
      try {
        execSync(`fuser -k ${port}/tcp 2>/dev/null || true`); // backstop; fuser may be absent
      } catch {
        // best effort
      }
      assert(false, "teardown: wrangler killed and port closed");
    } else {
      console.log("ok - teardown: wrangler killed and port closed");
    }
  }
}

let wrangler;
let wranglerLog = "";
try {
  port = await freePort();
  wrangler = spawnWrangler({ TSCHECKER: "tsc-rs-wasm" });
  wrangler.stdout.on("data", (d) => {
    wranglerLog += d;
  });
  wrangler.stderr.on("data", (d) => {
    wranglerLog += d;
  });

  // -- preflight: lazy identities still unloaded (BEFORE any check) --
  const healthz = await waitHealthy(() => wranglerLog);
  assert(healthz.status === 200, "boot: healthz HTTP 200 under TSCHECKER=tsc-rs-wasm");
  const runtime0 = healthz.json.data.runtime;
  assert(
    runtime0.typechecker === "unloaded",
    "preflight: typechecker unloaded before any check",
    runtime0.typechecker,
  );
  assert(runtime0.sandbox === "unloaded", "preflight: sandbox unloaded before any check", runtime0.sandbox);

  // -- route machinery unchanged by the selection (405 + 400 validation) --
  const notAllowed = await get("/typecheck");
  assert(
    notAllowed.status === 405 && notAllowed.headers.get("allow") === "POST",
    "405 GET /typecheck: allow POST response header",
  );
  const malformed = await post("/typecheck", "{nope");
  assert(
    malformed.status === 400 && malformed.json.error.code === "bad_request",
    "validation: malformed JSON -> 400 bad_request",
  );
  const empty = await post("/typecheck", JSON.stringify({ files: {} }));
  assert(
    empty.status === 400 && empty.json.error.code === "bad_request",
    "validation: empty files -> 400 bad_request",
  );

  // -- green guest through /typecheck (stats shape; WASM-02 clean case) --
  const green = await post("/typecheck", JSON.stringify({ files: { "guest.ts": GREEN }, runs: 2 }));
  assert(green.status === 200 && green.json.ok === true, "green: HTTP 200 ok envelope");
  assert(
    green.json.data.runs === 2 && green.json.data.results.every((r) => r.ok === true),
    "green: both runs ok (clean verdict via the wasm checker)",
  );
  assert(
    green.json.data.results.every((r) => r.ms > 0 && Number.isFinite(r.ms)),
    "green: every ms positive and finite (fresh instance per run)",
  );

  // -- red guest (WASM-02 red case, verdict level) --
  const red = await post("/typecheck", JSON.stringify({ files: { "guest.ts": RED }, runs: 1 }));
  assert(red.status === 200 && red.json.data.results[0].ok === false, "red: single run flags ok=false");

  // -- lib guest against the module's EMBEDDED lib closure --
  const lib = await post("/typecheck", JSON.stringify({ files: { "guest.ts": LIB_GUEST }, runs: 1 }));
  assert(
    lib.status === 200 && lib.json.data.results[0].ok === true,
    "lib-sanity: Map/Promise.all guest checks clean on the embedded lib closure",
  );

  // -- EXACT diagnostics via the /agent/shell typecheck op (WASM-02) --
  const shellCheck = (content) =>
    post(
      "/agent/shell",
      JSON.stringify({
        commands: [
          { op: "write", args: { file: "guest.ts", content } },
          { op: "typecheck" },
        ],
      }),
    );

  const redShell = await shellCheck(RED);
  const redResult = redShell.json.data.results[1].result;
  const rd0 = redResult.diagnostics[0];
  assert(
    redResult.ok === false &&
      redResult.diagnostics.length === 1 &&
      rd0.code === 2322 &&
      rd0.line === 1 &&
      rd0.column === 7 &&
      rd0.file === "/guest.ts",
    "exactness: RED guest TS2322 at /guest.ts 1:7 (1-based, ts-js-identical shape)",
    rd0,
  );

  const iter1 = await shellCheck(SLUGIFY_ITER1);
  const i1 = iter1.json.data.results[1].result;
  assert(
    i1.ok === false && i1.diagnostics.length === 2,
    "exactness: slugify iter1 yields exactly 2 diagnostics",
    i1.diagnostics?.length,
  );
  assert(
    i1.diagnostics[0].code === 2322 && i1.diagnostics[0].line === 2 && i1.diagnostics[0].column === 9,
    "exactness: slugify iter1 TS2322 at 2:9",
    i1.diagnostics[0],
  );

  const finalCheck = await shellCheck(SLUGIFY_FINAL);
  const fin = finalCheck.json.data.results[1].result;
  assert(
    fin.ok === true && fin.diagnostics.length === 0,
    "exactness: slugify final checks clean with 0 diagnostics",
  );

  // -- the agent loop runs over the SELECTED checker (factory routing; the
  // loop, /agent/shell and /typecheck share the one getTypechecker(env) seam) --
  const slug = await post("/agent/run", JSON.stringify({ task: SLUG_TASK, spec: SLUG_SPEC }));
  assert(slug.status === 200 && slug.json.ok === true, "agent loop: HTTP 200 ok envelope");
  assert(
    slug.json.data.status === "success" && slug.json.data.iterations.length === 3,
    "agent loop: converges to success in exactly 3 iterations over the wasm checker",
    slug.json.data.status,
  );
  const it1 = slug.json.data.iterations[0];
  assert(
    it1.typecheck !== null &&
      it1.typecheck.ok === false &&
      it1.typecheck.diagnostics[0].code === 2322 &&
      it1.typecheck.diagnostics[0].line === 2 &&
      it1.typecheck.diagnostics[0].column === 9 &&
      it1.typecheck.diagnostics[0].file === "/guest.ts",
    "agent loop: iter1 TS2322 at /guest.ts 2:9 fed back by the wasm checker (CORE-03 gate intact)",
    it1.typecheck?.diagnostics?.[0],
  );
  assert(
    slug.json.data.timings.typecheckMs > 0,
    "agent loop: timings.typecheckMs measured (wasm runs dominate the loop wall clock)",
    slug.json.data.timings?.typecheckMs,
  );

  // -- identity flip (LAST: the checks above did the lazy loading) --
  const flipped = await get("/healthz");
  assert(
    flipped.status === 200 && flipped.json.data.runtime.typechecker === "ts-rust@569df52 (wasm)",
    "flip: typechecker identity is ts-rust@569df52 (wasm) after first check",
    flipped.json.data.runtime.typechecker,
  );
} finally {
  await killWrangler();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed. wrangler log tail:\n${wranglerLog.slice(-2000)}`);
  process.exitCode = 1;
}
