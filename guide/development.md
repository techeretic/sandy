# Development

For contributors and anyone building on top of the codebase.

## Toolchain

- **Node ≥ 22**, **TypeScript 5.9** (strict, ESM). **Pin `typescript@5.9`** — the 7.x native compiler has a `@types/node` auto-include bug.
- **Vitest** for tests.
- Runtime dependencies are minimal: `@modelcontextprotocol/sdk`, `ajv`, `zod`. The binary report containers (ZIP/DOCX/XLSX/PDF) are hand-rolled to keep the install clean.

## Commands

| Command | What it does |
|---------|--------------|
| `npm ci` | Install the locked dependencies. |
| `npm run build` | Compile `src/` → `dist/` (`tsconfig.build.json`). |
| `npm run typecheck` | Type-check without emitting. |
| `npm test` | Run the full Vitest suite (323 tests). |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:conformance` | In-process conformance (no Docker needed). |
| `npm run conformance` | In-process + Docker egress + Docker/Firejail sandbox matrix. |
| `npm run conformance:docker` | Docker network-level egress proof. |
| `npm run conformance:sandbox` | Docker + Firejail runtime-agnosticity matrix. |

**After any change:** `npm run typecheck && npm test`. Add `npm run build` when `dist/` matters.

## Repository layout

```
src/
  cli.ts              CLI (check / run / ask / serve) + stable exit codes
  index.ts            public exports (everything is exported from here)
  sandy.ts            createSandy(deps) — the composition factory
  engine.ts           the LLM-engine seam + the four backends
  memory-bound.ts     opt-in in-service cgroup memory bound (issue #18)
  config/             sandy.json + mcp-servers.json schemas, fail-closed loader
  sandbox/            enforcer, runtime detection, capability manifest,
                      NetworkGuard (egress), PathConfinement
  mcp/                MCP client manager (lifecycle, allowlists, retries)
  files/              File Manager (confined CRUD, undo journal, formats)
  orchestrator/       orchestrator, report renderer (5 formats), request
                      schema, templates, write-back gate
  audit/              append-only audit log + transcript export
  standalone/         the autonomous loop (ask) + loopback-only REST API (serve)
  plugin/             the Claude Code / Codex MCP server (sandy.* tools)
bin/sandy.js          the CLI entry point
plugin/               plugin manifest + install.sh
scripts/provision-model.sh   model + runtime provisioning (out-of-band)
config/               annotated example configs
conformance/          egress + sandbox-matrix harnesses
tests/                the Vitest suite (12 files, 323 tests)
docs/                 engineering docs (PRD, design, decisions, diary)
guide/                this consumer-facing guide
```

Everything is exported from `src/index.ts`. Tests use `tests/helpers/mcp.ts` for in-process MCP servers and `tests/fixtures/stdio-mcp-server.mjs` for a stdio transport.

## Conventions (the invariants — keep them)

- **Fail closed** everywhere; never smooth over a gap; **policy > preferences** (tighten, never loosen).
- **Secrets only as `${ENV_REF}`**; resolve at point of use, never store or log; **args logged by hash** only (AU-02).
- **No network outside the declared MCP allowlist** — everything goes through `NetworkGuard`.
- **One definition of a legal request** — the shared `orchestratorRequestSchema` + legal tool catalog is used by the CLI, the plugin, the API, and the loop, so nothing is legal because it is "saved" or "planned."
- **Deterministic, zero-dependency** report renderers (Markdown is the source of truth; the other four are views over the same `(claims, gaps)`).
- Injectable seams for tests (detection, transport, `MemoryBoundOps`, progress sinks) — but **no production-reachable override**.

## Testing

The suite is 323 tests across 12 files, covering each module plus end-to-end `sandy` composition. The conformance suite is separate and is the **proof** of the security guarantees (below). In-process tests need no Docker; the Docker/Firejail legs do.

## Conformance

Conformance is how the guarantees are *proven*, not just asserted. Three layers:

1. **In-process** (`npm run test:conformance`) — the egress + sandbox conformance tests run in-process with no Docker. The fastest loop; runs in CI's `core` job.
2. **Docker network-level egress** (`npm run conformance:docker`) — the declared endpoint is an internal-network container; asserts the run succeeds against it, an independent external-egress probe **fails**, and an undeclared endpoint **fails closed at startup** (VPN-02). The shape of the PRD success criterion at the network level.
3. **Docker + Firejail matrix** (`npm run conformance:sandbox`) — the **same config + request** under both boundaries must produce **byte-identical** behavioral signatures (SB-10, runtime-agnosticity). A `signature.mjs` projects the runtime-agnostic fields (ok / degraded / lost / allowlist / MCP fleet / provenance) and excludes the legitimately runtime-specific ones (runtime name, absolute paths, timestamps, durations).

Both harnesses are **parameterized by mode** (`SANDY_MODE=standalone`), proving the no-egress / cross-sandbox guarantees hold for **both** plugin (`sandy run`) and standalone (`sandy ask`).

| Env var | Effect |
|---------|--------|
| `SANDY_MATRIX=docker\|firejail` | Run only that boundary (used by the CI matrix). Unset = run both + prove identity. |
| `SANDY_MODE=standalone` | Run the standalone service (`sandy ask` + a loopback stub-model) instead of plugin mode. |
| `SANDY_REQUIRE=1` | Fail-closed: a missing boundary/tool is an error, not a skip (used by CI). |
| `SANDY_REAL_MODEL=<gguf>` | **Opt-in** real-model leg (issue #17): the full `sandy ask` against the real provisioned GGUF in a no-egress Firejail jail. Skipped (never failed) unless set + the file exists + `llama-server` resolves, so CI with no model is untouched. |
| `SANDY_LLM_SERVER` | Override the `llama-server` path for the real-model leg. |

**CI** (`.github/workflows/ci.yml`) runs a `core` job (typecheck, build, test, in-process conformance) and a `boundary × mode` matrix (docker/firejail × plugin/standalone) that uploads a per-leg signature, then an `identity` job that **requires the Docker and Firejail signatures to be byte-identical per mode** — the CI-level form of the SB-10 / SD-05/06 proof.

## Documentation roles (keep them distinct)

Per the doc-role convention (issue #13):

- **`README.md`** — short headline status + links.
- **`guide/`** — *how to use it* (this folder).
- **`docs/`** — *why* and *how it got here*: `PRD_Final.md` (authoritative requirements), `PHASE2_DESIGN.md` (standalone design, SD-01..06), `MODEL.md` (provisioning + default model), `DECISIONS.md` (settled decisions + accepted limitations), `NEXT_STEPS.md` (forward-looking state + roadmap), `DIARY.md` (append-only chronological history).

**Don't restate a milestone in more than one of them** — point at the source. Update `docs/DIARY.md` per work block and keep `README.md`'s Status section current.

## Commit style

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `test:`, `perf:`, `security:`, `release:`), imperative subject. After each completed task, commit and push to the remote (per `AGENTS.md`).
