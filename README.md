# iso-agents

A prototype of an AI coding agent that lives entirely inside a Cloudflare workerd isolate:
given a small coding task and a spec, it generates TypeScript, type-checks it in-isolate,
executes it in a WASM sandbox, reads the diagnostics, and iterates until the code is green
— all within a single request. See AGENTS.md for project context and stack decisions.

## Commands

- `npm run dev` — start `wrangler dev` (real workerd, local, no Cloudflare account) on http://localhost:8787
- `npm run check` — strict type-check (`tsc --noEmit`)
- `npm test` — vitest run (tests execute inside workerd via @cloudflare/vitest-plugin)
- `npm run bundle:check` — dry-run production bundle gate (no upload)

## Smoke test

```sh
npm run dev &
sleep 8
curl -s --max-time 5 http://localhost:8787/healthz
```

Returns the JSON envelope: `{"ok":true,"data":{"status":"ok","runtime":{...}}}` with
`typechecker` and `sandbox` reporting `"unloaded"` until later phases load them, and
`workerd`/`userAgent` reporting `navigator.userAgent` (best-effort runtime identity —
workerd has no in-band version API, so these are asserted as non-empty strings).
