# Plan Review: Phase 1

**Verdict:** REVISE

**Reviewer:** gsd-plan-checker, 2026-10-11
**Scope:** 01-01-PLAN.md, 01-02-PLAN.md vs ROADMAP Phase 1 (SC1–4, RUN-01..03), REQUIREMENTS.md, 01-CONTEXT.md, 01-RESEARCH.md.
**Evidence basis:** several claims below were verified by compiling the exact planned files with typescript@6.0.3 + @cloudflare/workers-types@5.20261010.1 (see Issue 1) and by hand-tracing every `grep -c` acceptance criterion against the exact planned file contents.

## Checks table

| Check | Result | Notes |
|---|---|---|
| 1. Coverage (RUN-01..03 + Phase 1 SC1–4) | **FAIL (partial)** | RUN-01, RUN-03, SC2, SC3, SC4 fully covered across both plans. **RUN-02/SC1 gap:** both name "workerd version" in the runtime identity; plans ship `workerd: "unknown"` (see Issue 2). All other identity fields (compat date, typechecker/sandbox placeholders per CONTEXT, instanceId) covered. |
| 2. Locked decisions respected | **PASS** (with one gate bug) | Envelope `{ok:true,data}`/`{ok:false,error:{code,message,detail?}}` ✓; switch on `` `${method} ${pathname}` ``, no framework ✓; typed `Env` + `.dev.vars.example` with LLM_BASE_URL/LLM_API_KEY/LLM_MODEL/AGENT_MAX_ITERATIONS=5/SANDBOX_TIMEOUT_MS=2000 (+LLM_PROVIDER, beneficial) ✓; vitest 4.1.11 + @cloudflare/vitest-plugin 1.4.0, never pool-workers ✓; `console.*` with `[worker]` prefix ✓; both `no_nodejs_compat` flags + `compatibility_date: "2026-09-01"` present ✓; `"typescript": "6.0.3"` exact pin, no caret/range/latest, no deploy script ✓. BUT the acceptance grep that proves the two flags is miscounted (Issue 3). |
| 3. Executability | **FAIL** | Exact file contents + read_first + verify + grep-able acceptance_criteria present for every task; wave/dependency structure sane (01-02 wave 2 depends_on 01-01). But 6 acceptance-criteria counts are wrong (Issues 3, 4, 5, 6, 8, 9) and one planned test file is guaranteed to fail `npm run check` (Issue 1). |
| 4. Technical soundness | **FAIL (partial)** | 404 unknown route / 404 unknown run / 405 with `allow` header / 501 both POST routes / 500 catch-all: correct, switch fallthrough traced clean (e.g. `GET /agent/run` → 405 via KNOWN_PATHS). healthz shape internally consistent between 01-01 source, README expected body, and 01-02 tests. `cloudflareTest({wrangler:{configPath}})` config matches verified docs form; tsconfig `module:"ES2022"`+`moduleResolution:"bundler"` pair **compile-verified** with typescript@6.0.3; `types:["@cloudflare/vitest-plugin/types"]` **resolution-verified** (exports map `./types` honored). **Break:** `exports.default.fetch(...)` in test/healthz.spec.ts does not type-check as planned (Issue 1); workerd identity placeholder vs SC1 (Issue 2). |
| 5. Frontmatter validity | **PASS** | Both plans: valid YAML; phase/plan/title/wave/depends_on/files_modified/requirements/autonomous all present; files_modified unions match task `<files>` lists (generated `dist-bundle/` correctly excluded); 01-02 `depends_on: [01-01]` matches wave order; `requirements` lists match delivered work. (Issue 1's fix adds one file to 01-02's files_modified.) |

## Issues (blocking)

1. **01-02, task 2 — `exports.default` is a guaranteed type error under the planned toolchain.** `cloudflare:workers`' `exports` is typed `Cloudflare.Exports` (workers-types index.d.ts:16687 → `export const exports: Cloudflare.Exports`), which maps over `Cloudflare.GlobalProps["mainModule"]` — `{}` when `GlobalProps` is undeclared (the no-`wrangler types` flow 01-01 ships). **Verified by compiling** the exact planned test + tsconfig with typescript@6.0.3: `error TS2339: Property 'default' does not exist on type 'Exports'`. This fails task 2's `npm run check → exit 0` criterion and 01-02's final verification chain. **Required fix:** add a declaration file, e.g. `test/cloudflare-globals.d.ts` (matched by the existing `test/**/*.ts` include glob):
   ```ts
   declare namespace Cloudflare {
     interface GlobalProps {
       mainModule: { default: ExportedHandler };
     }
   }
   ```
   This was **compile-verified to exit 0** (exports.default then gets a `Fetcher` loopback type; `.fetch(url)`, `.fetch(url, {method})`, `res.headers.get`, `res.json()` all check clean). Then add the file to 01-02 frontmatter `files_modified` and to task 2's `<files>`. (Alternative: cast `(exports.default as Fetcher).fetch(...)` at each call site, or use `SELF` from `cloudflare:test` — the d.ts declaration is preferred and future-proofs Phase 2+ tests.)

2. **01-01 task 3 (+ 01-02 task 2 assertions) — RUN-02/SC1 "workerd version" is delivered as a literal `"unknown"`, while the plans claim the criterion achieved.** RUN-02 and ROADMAP SC1 both list workerd version in the runtime identity; CONTEXT blesses placeholders only for `typechecker`/`sandbox`. RESEARCH Gotcha 6 explicitly offers two concrete options (report `navigator.userAgent` as best-effort and assert non-empty; or a wrangler-derived constant `workerd 1.20261006.1` from wrangler 4.149.0's dependency manifest) and the plan picked neither — yet 01-01's `must_haves`/`verification` and 01-02 task 3's `done` claim SC1/RUN-02 fully demonstrated. **Required fix:** pick one option and carry it through consistently — recommended: `userAgent: navigator.userAgent` (or keep the `workerd` key with that value) in `getRuntimeInfo()`, assert non-empty string in test/healthz.spec.ts and the README/curl expected bodies — OR record `workerd: "1.20261006.1 (via wrangler 4.149.0)"` with a comment that it must be re-derived on wrangler upgrades. If the team prefers the honest `"unknown"` placeholder, that requires explicitly amending ROADMAP SC1 / RUN-02 wording instead — plans must not silently under-deliver a criterion they mark achieved.

3. **01-01, task 2 (verify + acceptance_criteria) — `grep -c 'no_nodejs_compat' wrangler.jsonc → 2` is wrong: both flags sit on ONE line and `grep -c` counts lines, so it returns 1.** As written, the gate for the locked both-flags decision spuriously fails (or worse, tempts splitting the line). **Required fix:** count occurrences, e.g. `grep -o 'no_nodejs_compat' wrangler.jsonc | wc -l → 2`, or two line-greps: `grep -c '"no_nodejs_compat"' → 1` plus `grep -c 'no_nodejs_compat_v2' → 1`.

4. **01-01, task 3 — `grep -c 'method_not_allowed' src/index.ts → 1` is wrong: it appears twice (ErrorCode union member + the 405 `fail(...)` call), same pattern as the sibling `not_implemented → 2` criterion which is correct.** An over-literal executor could "fix" the count by deleting the union member, which breaks the 405 branch under strict tsc. **Required fix:** expected count → 2.

5. **01-01, task 3 — `grep -c 'parseJsonBody' src/index.ts → "2 (comment + definition) or more"` is wrong: only the definition line contains the name (the preceding comment doesn't mention it), so the count is 1.** 1 is not ≥ 2, so the criterion fails on a correct file. **Required fix:** expected count → 1 (or add `parseJsonBody` to the comment text).

6. **01-01, task 4 — `grep -c 'iso-agents' dist-bundle/index.js → at least 1` will return 0.** The bundle is esbuild output of src/index.ts + src/runs.ts, neither of which contains the literal `iso-agents`, and `wrangler deploy --dry-run --outdir` does not inject the project name into the bundle. **Required fix:** grep a string actually in the worker source, e.g. `grep -c 'not_implemented' dist-bundle/index.js` ≥ 1 (or `healthz`), keeping the intent "bundle is our worker".

7. **01-01, task 5 — `grep -c 'npm run dev' README.md → 1` is wrong: the Commands bullet and the smoke-test code block line both contain it, so the count is 2.** **Required fix:** expected count → 2 (or anchor the pattern to the bullet, e.g. `grep -c '^- .npm run dev' README.md → 1`).

8. **01-02, task 1 — `grep -c 'cloudflareTest' vitest.config.ts → 1` is wrong: the import and the plugin usage are two lines, so the count is 2.** **Required fix:** expected count → 2.

9. **01-02, task 2 — `grep -c 'runRegistry' test/runs.spec.ts → 3` is wrong: import, `describe("runRegistry"…)`, `runRegistry.create()`, `runRegistry.get(run.id)`, and `runRegistry.get("nope")` make 5 matching lines.** **Required fix:** expected count → 5 (or drop this grep — `npm test` green already proves the seam).

## Suggestions (non-blocking)

- `kill %1` (01-01 task 5, 01-02 task 3) can fail in non-interactive shells where job control is off ("no such job"), leaving the dev server running to break the later wave's port-8787 smoke. Prefer capturing the PID (`CI=true npm run dev … & WRANGLER_PID=$!` … `kill $WRANGLER_PID`) or `pkill -f 'wrangler dev'`.
- 01-01 task 5's README block nests ```sh fences inside the ```markdown exact-content fence; naive copy fidelity is ambiguous at the inner close. Consider an outer `~~~` fence or indenting the inner block.
- Health payload uses snake_case (`compatibility_date`, `uptime_s`) where the RESEARCH skeleton used camelCase (`compatibilityDate`). Internally consistent across both plans, and nothing locks the naming — just record it as the API contract so Phases 2–4 keep the same field names.
- The `.dev.vars.example` jsonc-parse verify (task 2) strips `//…` to end-of-line; safe today, but would mangle any future `https://…` URL in a wrangler.jsonc comment or value — fine to keep, just don't generalize it.
- Positive verifications from this review, usable as-is by executors: (a) `module: "ES2022"` + `moduleResolution: "bundler"` compiles clean under typescript@6.0.3; (b) `types: ["@cloudflare/vitest-plugin/types"]` resolves via the package exports map and provides `cloudflare:test` declarations; (c) the Issue-1 `GlobalProps` declaration is the minimal, verified fix for `exports.default`.
- 01-02 task 1's verify prose about `npm test` "may still fail with No test files found — EXPECTED" is fine, but consider `vitest run --passWithNoTests`-free phrasing kept as-is; the acceptance criteria correctly rely only on `npm run check` at that stage.
