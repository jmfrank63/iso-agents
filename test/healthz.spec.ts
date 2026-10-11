import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /healthz", () => {
  it("returns the ok envelope with runtime identity", async () => {
    const res = await exports.default.fetch("http://example.com/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { status: string; runtime: Record<string, unknown> };
    };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
    // workerd has no in-band version API: workerd/userAgent carry best-effort
    // navigator.userAgent — assert non-empty, never a literal placeholder.
    expect(typeof body.data.runtime.workerd).toBe("string");
    expect((body.data.runtime.workerd as string).length).toBeGreaterThan(0);
    expect(typeof body.data.runtime.userAgent).toBe("string");
    expect((body.data.runtime.userAgent as string).length).toBeGreaterThan(0);
    expect(body.data.runtime.compatibility_date).toBe("2026-09-01");
    expect(body.data.runtime.typechecker).toBe("unloaded");
    expect(body.data.runtime.sandbox).toBe("unloaded");
    expect(typeof body.data.runtime.instanceId).toBe("string");
    expect((body.data.runtime.instanceId as string).length).toBe(36);
    expect(typeof body.data.runtime.uptime_s).toBe("number");
  });
});

describe("structured errors", () => {
  it("404 envelope for unknown route", async () => {
    const res = await exports.default.fetch("http://example.com/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("not_found");
  });

  it("404 envelope for unknown run id (registered route, unknown resource)", async () => {
    const res = await exports.default.fetch(
      "http://example.com/agent/run/00000000-0000-4000-8000-000000000000",
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("405 envelope for known path with wrong method", async () => {
    const res = await exports.default.fetch("http://example.com/healthz", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("method_not_allowed");
  });

  it("501 envelope for registered-but-unimplemented POST routes", async () => {
    const res = await exports.default.fetch("http://example.com/typecheck", { method: "POST" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("not_implemented");
  });

  it("501 envelope for POST /agent/run", async () => {
    const res = await exports.default.fetch("http://example.com/agent/run", { method: "POST" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("not_implemented");
  });
});
