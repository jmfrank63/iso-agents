import { runRegistry } from "./runs";
import { getTypechecker, getTypecheckerIdentity } from "./typecheck";
import { getSandboxRuntime } from "./sandbox/runtime";
import { getSandboxIdentity } from "./sandbox/identity";

export interface Env {
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  AGENT_MAX_ITERATIONS?: string;
  SANDBOX_TIMEOUT_MS?: string;
  SANDBOX_MEMORY_LIMIT_MB?: string;
  SANDBOX_STACK_KB?: string;
}

const COMPATIBILITY_DATE = "2026-09-01";
// Per isolate; surfaces restarts. workerd freezes Date.now() in global scope
// (module init reads ~0), so boot time is captured lazily on first request
// and memoized for the isolate's lifetime.
let bootMs: number | undefined;
function bootMsOnce(): number {
  return (bootMs ??= Date.now());
}
// Per isolate boot; surfaces restarts. workerd disallows random-value
// generation in global scope, so the id is generated lazily on first request
// and memoized for the isolate's lifetime.
let instanceId: string | undefined;
function instanceIdOnce(): string {
  return (instanceId ??= crypto.randomUUID());
}

type ErrorCode =
  | "bad_request"
  | "not_found"
  | "method_not_allowed"
  | "not_implemented"
  | "internal";

type Envelope =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: ErrorCode; message: string; detail?: unknown } };

function json(body: Envelope, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function fail(
  status: number,
  code: ErrorCode,
  message: string,
  detail?: unknown,
  headers?: Record<string, string>,
): Response {
  const error = detail !== undefined ? { code, message, detail } : { code, message };
  return json({ ok: false, error }, status, headers);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

// Pre-wired for Phase 2/4 POST routes (400 bad_request on malformed JSON).
// Phase 1 has no implemented POST body route, so this is unexercised by tests.
async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "bad_request", "request body is not valid JSON");
  }
}

interface TypecheckBody {
  files?: Record<string, unknown>;
}

// TYPE-02 early HTTP path: one wall-ms check per request (TYPE-03's N-run
// stats land in Phase 4). Snippet names are VFS-rooted: "guest.ts" is
// checked as "/guest.ts". Responds 200 with data.ok=false when the checked
// code has errors — the check itself succeeded.
async function handleTypecheck(request: Request): Promise<Response> {
  const body = (await parseJsonBody(request)) as TypecheckBody | null;
  if (
    body === null ||
    typeof body !== "object" ||
    body.files === undefined ||
    body.files === null ||
    typeof body.files !== "object"
  ) {
    throw new HttpError(400, "bad_request", "body must be JSON {files: {name: content}}");
  }
  const entries = Object.entries(body.files);
  if (entries.length === 0) {
    throw new HttpError(400, "bad_request", "files must contain at least one entry");
  }
  const bad = entries.find(([, content]) => typeof content !== "string");
  if (bad !== undefined) {
    throw new HttpError(400, "bad_request", `files.${bad[0]} must be a string`);
  }
  const files = new Map<string, string>(
    entries.map(([name, content]): [string, string] => [
      name.startsWith("/") ? name : `/${name}`,
      content as string,
    ]),
  );
  const result = await getTypechecker().check(files);
  return json({ ok: true, data: result }, 200);
}

interface SandboxExecuteBody {
  code?: unknown;
}

// SAND-01..04 debug surface (prototype affordance): executes posted JS in the
// QuickJS-WASM sandbox and returns the structured ExecuteResult. Phase 4's
// agent loop calls getSandboxRuntime(env).execute() directly; this route
// exists so every guardrail is curl-verifiable under wrangler dev. 200 even
// when data.status is error/timeout/crash — the execution itself succeeded.
async function handleSandboxExecute(request: Request, env: Env): Promise<Response> {
  const body = (await parseJsonBody(request)) as SandboxExecuteBody | null;
  if (body === null || typeof body !== "object" || typeof body.code !== "string") {
    throw new HttpError(400, "bad_request", "body must be JSON {code: string}");
  }
  const result = await getSandboxRuntime(env).execute(body.code);
  return json({ ok: true, data: result }, 200);
}

// Lazy-init seam: Phases 2-3 fill typechecker/sandbox identities; /healthz stays fast.
export function getRuntimeInfo() {
  return {
    // Best-effort workerd version: workerd has no in-band version API, so
    // navigator.userAgent is the only in-band signal (tests assert non-empty).
    workerd: navigator.userAgent,
    compatibility_date: COMPATIBILITY_DATE,
    typechecker: getTypecheckerIdentity(), // flips after first checker use (lazy singleton)
    sandbox: getSandboxIdentity(), // flips after first sandbox execution (lazy module load)
    instanceId: instanceIdOnce(),
    uptime_s: Math.floor((Date.now() - bootMsOnce()) / 1000),
    userAgent: navigator.userAgent, // raw signal behind the `workerd` best-effort above
  };
}

const KNOWN_PATHS: Record<string, string> = {
  "/healthz": "GET",
  "/agent/run": "POST",
  "/typecheck": "POST",
  "/sandbox/execute": "POST",
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const started = performance.now();
    const { method, pathname } = { method: request.method, pathname: new URL(request.url).pathname };
    const label = `${method} ${pathname}`;
    const respond = (res: Response): Response => {
      console.log(`[worker] ${label} -> ${res.status} (${(performance.now() - started).toFixed(1)}ms)`);
      return res;
    };
    try {
      switch (`${method} ${pathname}`) {
        case "GET /healthz":
          return respond(json({ ok: true, data: { status: "ok", runtime: getRuntimeInfo() } }, 200));
        case "POST /agent/run":
          return respond(fail(501, "not_implemented", `${label} is registered but not implemented yet`));
        case "POST /typecheck":
          return respond(await handleTypecheck(request));
        case "POST /sandbox/execute":
          return respond(await handleSandboxExecute(request, env));
        default: {
          if (method === "GET" && pathname.startsWith("/agent/run/")) {
            const id = pathname.slice("/agent/run/".length);
            const run = runRegistry.get(id);
            if (run === undefined) {
              return respond(
                fail(404, "not_found", `run ${id} not found`, {
                  id,
                  hint: "in-memory store; isolate restart clears it",
                }),
              );
            }
            return respond(json({ ok: true, data: run }, 200));
          }
          const allowedMethod = KNOWN_PATHS[pathname];
          if (allowedMethod !== undefined) {
            return respond(
              fail(405, "method_not_allowed", `${label} not allowed; use ${allowedMethod} ${pathname}`, undefined, {
                allow: allowedMethod,
              }),
            );
          }
          return respond(fail(404, "not_found", `no route for ${label}`));
        }
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : "internal";
      const message = err instanceof Error ? err.message : String(err);
      const detail = err instanceof HttpError ? err.detail : { instanceId: instanceIdOnce() };
      console.error(`[worker] ${label} failed:`, err);
      return respond(fail(status, code, message, detail));
    }
  },
} satisfies ExportedHandler<Env>;
