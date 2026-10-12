// Live in-workerd verification harness for the Phase 2 checker (`npm run test:live`).
//
// Why this exists: the @cloudflare/vitest-plugin transport crashes workerd once the
// 8.8 MB typescript module enters the worker graph (WebSocket 1009 "Message is too
// large" — review issue 1, reproduced 4x), so NO vitest spec may pull the typecheck
// graph. Every typecheck/route/flip expectation runs here instead, against real
// workerd via `wrangler dev` — the transport research verified with the full 11 MB
// bundle. Boots CI=true wrangler dev on a free port, polls /healthz, POSTs the
// red/green/lib-sanity/memoization snippets, asserts exact JSON outcomes (incl.
// TS2322 at 1-based column 7), kills wrangler, and exits non-zero on any failure.
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

// Guest snippets — byte-identical to the originally planned vitest cases, so every
// expected value maps 1:1 (see the mapping table in 02-02-PLAN.md).
const GREEN = "export const answer: number = 42;\n";
const RED = 'const n: number = "not a number";\nconsole.log(n);\n';
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

let port;

async function get(path, { method = "GET", body, headers } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(10000),
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

let wrangler;
let wranglerLog = "";
try {
  // Free port: bind 0, read the assigned port, release (tiny race, fine for dev).
  port = await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const chosen = srv.address().port;
      srv.close(() => resolve(chosen));
    });
    srv.on("error", reject);
  });
  wrangler = spawn("wrangler", ["dev", "--port", String(port)], {
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group so teardown kills wrangler + workerd together
  });
  wrangler.on("error", (err) => {
    console.error(`FAIL - could not spawn wrangler (run this via npm run test:live): ${err.message}`);
    process.exit(1);
  });
  wrangler.stdout.on("data", (d) => {
    wranglerLog += d;
  });
  wrangler.stderr.on("data", (d) => {
    wranglerLog += d;
  });

  // Poll /healthz until the dev server answers (60s budget).
  let healthz = null;
  for (let i = 0; i < 60 && healthz === null; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) healthz = { status: res.status, headers: res.headers, json: await res.json() };
    } catch {
      // not up yet
    }
  }
  if (healthz === null) {
    throw new Error(`wrangler dev did not serve /healthz within 60s. Log tail:\n${wranglerLog.slice(-2000)}`);
  }

  // -- Phase 1 healthz coverage, relocated from test/healthz.spec.ts (issue-1 fix) --
  assert(healthz.status === 200, "healthz: HTTP 200");
  assert(healthz.json.ok === true && healthz.json.data.status === "ok", "healthz: ok envelope with status ok");
  const runtime = healthz.json.data.runtime;
  assert(typeof runtime.workerd === "string" && runtime.workerd.length > 0, "healthz: runtime.workerd non-empty string");
  assert(typeof runtime.userAgent === "string" && runtime.userAgent.length > 0, "healthz: runtime.userAgent non-empty string");
  assert(runtime.compatibility_date === "2026-09-01", "healthz: compatibility_date is 2026-09-01");
  assert(runtime.typechecker === "unloaded", "healthz: typechecker is unloaded before any check", runtime.typechecker);
  assert(runtime.sandbox === "unloaded", "healthz: sandbox is unloaded");
  assert(typeof runtime.instanceId === "string" && runtime.instanceId.length === 36, "healthz: instanceId is a 36-char uuid");
  assert(typeof runtime.uptime_s === "number", "healthz: uptime_s is a number");

  // -- Phase 1 route coverage (unchanged semantics post-wiring) --
  const nf = await get("/nope");
  assert(nf.status === 404 && nf.json.error.code === "not_found", "404 unknown route returns not_found");
  const nfr = await get("/agent/run/00000000-0000-4000-8000-000000000000");
  assert(nfr.status === 404 && nfr.json.error.code === "not_found", "404 unknown run id returns not_found");
  const del = await get("/healthz", { method: "DELETE" });
  assert(
    del.status === 405 && del.json.error.code === "method_not_allowed" && del.headers.get("allow") === "GET",
    "405 DELETE /healthz returns allow: GET",
  );
  const unimplemented = await post("/agent/run", "");
  assert(
    unimplemented.status === 501 && unimplemented.json.error.code === "not_implemented",
    "501 POST /agent/run returns not_implemented",
  );

  // -- Case 1 + 7: green guest / green snippet over the route --
  const green = await post("/typecheck", JSON.stringify({ files: { "guest.ts": GREEN } }));
  assert(green.status === 200, "green: HTTP 200 envelope");
  assert(green.json.ok === true, "green: envelope ok is true");
  assert(green.json.data.ok === true, "green: data.ok is true");
  assert(green.json.data.diagnostics.length === 0, "green: zero diagnostics");
  assert(green.json.data.ms > 0 && Number.isFinite(green.json.data.ms), "green: ms is positive and finite");

  // -- Case 2 + 6: red guest exactness / red snippet over the route --
  const red = await post("/typecheck", JSON.stringify({ files: { "guest.ts": RED } }));
  assert(red.status === 200, "red: HTTP 200 even though data.ok is false");
  assert(red.json.ok === true, "red: envelope ok is true");
  assert(red.json.data.ok === false, "red: data.ok is false");
  assert(red.json.data.ms > 0, "red: ms is positive");
  assert(red.json.data.diagnostics.length === 1, "red: exactly one diagnostic");
  const d = red.json.data.diagnostics[0];
  assert(d.code === 2322, "red: code is 2322");
  assert(
    d.message.includes("is not assignable to type 'number'"),
    "red: message contains is not assignable to type 'number'",
    d.message,
  );
  assert(d.line === 1, "red: 1-based line is 1");
  assert(d.column === 7, "red: 1-based column is 7 (TS reports the declared name, not the literal)", d.column);
  assert(d.file === "/guest.ts", "red: file is /guest.ts");
  assert(d.category === "Error", "red: category is Error");

  // -- Case 3: lib closure + guest globals --
  const lib = await post("/typecheck", JSON.stringify({ files: { "guest.ts": LIB_GUEST } }));
  assert(
    lib.status === 200 && lib.json.ok === true && lib.json.data.ok === true,
    "lib-sanity: Map/Promise.all/console guest checks clean",
  );
  assert(lib.json.data.diagnostics.length === 0, "lib-sanity: zero diagnostics total");
  assert(
    lib.json.data.diagnostics.filter((x) => x.file.startsWith("lib.")).length === 0,
    "lib-sanity: zero diagnostics from lib.* files",
  );

  // -- Case 4: memoization timing fidelity (same isolate => the checker is warm
  // by now; the CONTEXT decision calls this a sanity bound, not a cold->warm demo) --
  const first = await post("/typecheck", JSON.stringify({ files: { "guest.ts": GREEN } }));
  const second = await post("/typecheck", JSON.stringify({ files: { "guest.ts": GREEN } }));
  assert(first.json.data.ms > 0 && second.json.data.ms > 0, "memoization: both ms positive");
  assert(first.json.data.ms < 2000 && second.json.data.ms < 2000, "memoization: both under 2000ms");
  assert(second.json.data.ms <= first.json.data.ms + 100, "memoization: second <= first + 100ms");

  // -- Case 5: seam. HTTP-reachable half only: the locked route contract pins
  // createTypechecker()'s default "ts" implementation per request, so the harness
  // asserts that impl's id via the healthz identity below (same expected value the
  // planned vitest case checked: id contains "6.0.3"). transpile-only SELECTABILITY
  // is not reachable over HTTP; it is enforced by the tsc-typed Typechecker
  // interface (npm run check) plus the grep gate:
  // `grep -c 'new TranspileOnlyTypechecker()' src/typecheck/index.ts` -> 1.

  // -- Cases 8 + 9: validation --
  const empty = await post("/typecheck", JSON.stringify({ files: {} }));
  assert(empty.status === 400 && empty.json.error.code === "bad_request", "empty files object: 400 bad_request");
  const malformed = await post("/typecheck", "{nope");
  assert(malformed.status === 400 && malformed.json.error.code === "bad_request", "malformed JSON body: 400 bad_request");

  // -- Issue-6 fix: 405 GET /typecheck asserts the allow RESPONSE HEADER --
  const notAllowed = await get("/typecheck");
  assert(notAllowed.status === 405, "GET /typecheck: 405 status");
  assert(
    notAllowed.headers.get("allow") === "POST",
    "GET /typecheck: allow: POST response header (never the body)",
  );
  assert(notAllowed.json.error.code === "method_not_allowed", "GET /typecheck: method_not_allowed error code");

  // -- Case 10: identity flip (also carries case 5's id expectation) --
  const flip = await get("/healthz");
  assert(
    flip.status === 200 && flip.json.data.runtime.typechecker === "typescript@6.0.3 (in-isolate)",
    "identity flip: typescript@6.0.3 (in-isolate) after first check",
    flip.json.data.runtime.typechecker,
  );
} finally {
  // Teardown: kill the whole process group (NEVER `pkill -f wrangler` — argv
  // self-match kills your own shell), then a port-scoped backstop.
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

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed. wrangler log tail:\n${wranglerLog.slice(-2000)}`);
  process.exitCode = 1;
}
