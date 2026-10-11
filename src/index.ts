import { runRegistry } from "./runs";

export interface Env {
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  AGENT_MAX_ITERATIONS?: string;
  SANDBOX_TIMEOUT_MS?: string;
}

const COMPATIBILITY_DATE = "2026-09-01";
const BOOT_MS = Date.now();
const INSTANCE_ID = crypto.randomUUID(); // per isolate boot; surfaces restarts

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

// Lazy-init seam: Phases 2-3 fill typechecker/sandbox identities; /healthz stays fast.
export function getRuntimeInfo() {
  return {
    // Best-effort workerd version: workerd has no in-band version API, so
    // navigator.userAgent is the only in-band signal (tests assert non-empty).
    workerd: navigator.userAgent,
    compatibility_date: COMPATIBILITY_DATE,
    typechecker: "unloaded", // Phase 2: pinned pure-JS typescript version
    sandbox: "unloaded", // Phase 3: quickjs variant id
    instanceId: INSTANCE_ID,
    uptime_s: Math.floor((Date.now() - BOOT_MS) / 1000),
    userAgent: navigator.userAgent, // raw signal behind the `workerd` best-effort above
  };
}

const KNOWN_PATHS: Record<string, string> = {
  "/healthz": "GET",
  "/agent/run": "POST",
  "/typecheck": "POST",
};

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
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
        case "POST /typecheck":
          return respond(fail(501, "not_implemented", `${label} is registered but not implemented yet`));
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
      const detail = err instanceof HttpError ? err.detail : { instanceId: INSTANCE_ID };
      console.error(`[worker] ${label} failed:`, err);
      return respond(fail(status, code, message, detail));
    }
  },
} satisfies ExportedHandler<Env>;
