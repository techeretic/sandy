# Next Steps — Resume Point

_Last updated 2026-08-17. Read this together with `docs/DIARY.md` (chronological log) and `docs/DECISIONS.md` (resolved open questions)._

## Status

All of the **core library is built and tested** (94/94 tests, typecheck + build green). The pieces are complete but **not yet composed into a runnable program or a plugin**. The remaining work is integration + the Phase 1 flagship deliverable (the Claude Code / Codex plugin) + the launch conformance gate.

Commits so far (oldest → newest):
- `fa61dc5` config layer (Zod schemas + fail-closed loader)
- `a41fb93` Sandbox Enforcer
- `d02371e` MCP Client Manager
- `7e2609a` File Manager
- `42db211` Audit Logger + Orchestrator

## What's built (do not rebuild)

| Module | Path | Covers |
|--------|------|--------|
| Config | `src/config/` | `sandy.json` + `mcp-servers.json` schemas, fail-closed loader, env-ref-only secrets, version pins, VPN-02 cross-check |
| Sandbox Enforcer | `src/sandbox/` | runtime detection, real-path path confinement (symlink-escape refusal), capability manifest + reduced-mode report, NetworkGuard egress choke point |
| MCP Client Manager | `src/mcp/` | multi-server lifecycle (stdio/sse/http), startup validation, per-server tool allowlists (pre-wire), retries/backoff, terminal failures, args-by-hash audit; all HTTP through NetworkGuard |
| File Manager | `src/files/` | confined CRUD, confirmation gates, undo journal (+subtree snapshots), dry-run, ignore patterns, format validation (text/csv/json/md) |
| Audit | `src/audit/` | append-only structured log (in-memory + JSONL), opt-in payloads, sink bridges, session transcript export |
| Orchestrator | `src/orchestrator/` | bounded fan-out, provenance claims, explicit gaps, Markdown report renderer, progress events, write-gate contract (ReadOnlyGate) |

Everything is exported from `src/index.ts`. Tests live in `tests/` (use `tests/helpers/mcp.ts` for in-process MCP servers).

## Remaining work, in order

### 1. CLI / service entry point (do this first)
Compose the existing modules into a runnable `sandy` binary that is the spine the plugin will attach to.
- New: `src/sandy.ts` (a `createSandy(deps)` factory) + `src/cli.ts` + a `bin` entry in `package.json`.
- Startup sequence (all already exist, just wire them):
  1. `loadSandyConfig(sandyPath)` (fail-closed, CP-04)
  2. `SandboxEnforcer.create(sandbox, manifest)` — refuses unsandboxed / runtime mismatch; surfaces reduced-mode report
  3. `JsonlAuditLogger` (or in-memory) → derive `mcpAuditSink` + `fileAuditSink`
  4. `McpClientManager(manifest.servers, resolver, new NetworkGuard(allowed_network), { audit: mcpAuditSink })` → `connectAll()`; record startup failures
  5. `FileManager({ confinement: enforcer.paths, policy, journal, audit: fileAuditSink })`
  6. `createOrchestrator({ manager, audit, files, reportDir })`
- Minimal CLI verbs: `sandy check` (validate config + print capability/health report), `sandy run <request.json>` (execute an `OrchestratorRequest`, print claims/gaps, write report). Keep the model out of the CLI — it orchestrates; the LLM (plugin host or bundled) supplies the request.
- Log the startup capability report + any reduced-mode losses; exit non-zero if unsandboxed.
- **Verify:** end-to-end `sandy run` against an in-process or local stdio MCP server.

### 2. Claude Code / Codex plugin (PL-01..PL-04) — the Phase 1 flagship
- **Key design decision to lock first:** the plugin's tool surface. In plugin mode the *host* LLM does the reasoning (PL-03); Sandy exposes sandboxed capabilities the host can call. Recommended: expose Sandy as a small set of host-side tools:
  - `sandy.gather` (body = `OrchestratorRequest.gather`) → returns claims + gaps + progress
  - `sandy.report` (body = `OrchestratorRequest.report`) → renders + writes, returns path + content
  - `sandy.files.read|list|write|delete|mkdir|rename` (thin wrappers over `FileManager`)
  - `sandy.status` (capability report + MCP health + failed servers)
- The host LLM decides which tools to call and composes the narrative `summary`; Sandy returns provenance + gaps so the host can cite and disclose them.
- Install per Q3: git repo + manual install (a `plugin/` dir + a `sandy.plugin.json` / `.claude-plugin/plugin.json` manifest + install script). No registry dependency.
- Register capabilities with the host (PL-02). Plugin name "Sandy" (PL-04).
- **Open question to resolve:** how the plugin hands back `ProgressEvent`s for Q4 streaming within the host's UI (host may only surface final tool results).

### 3. Egress conformance test (launch success criterion)
Automate "zero network egress outside declared MCP endpoints" (verifiable at the network level) in **at least Docker + Firejail** (SB-09; PRD §11/§12).
- A test harness that: starts Sandy inside the sandbox with a config allowing exactly one endpoint; runs a request; captures all outbound traffic (e.g. a transparent proxy / `iptables` + log, or `nethogs`/`tcpdump` in CI); asserts the only destination is the declared endpoint.
- Also assert the reverse: with a malicious/undeclared endpoint in config, startup fails closed (VPN-02) and nothing leaves.
- This is the single strongest claim in the PRD's success criteria — make it a first-class, CI-runnable check.

### 4. Sandbox conformance (SB-09/10)
Confirm `sandy check`/`run` behave identically under Docker and Firejail (the enforcer is runtime-agnostic; this proves it). Add a smoke matrix to CI.

### 5. Model engine wiring (depends on mode)
- **Plugin mode:** no bundled model needed — the host LLM is the engine. Only need the `logModelInvocation` hook fed from the host (token counts) if the host exposes them.
- **Standalone mode (Phase 2):** bundle a 4–8B model (llama.cpp bindings). Out of scope for Phase 1 — leave a clean `LlmEngine` interface seam.

### Explicitly deferred (Phase 2 / later, per DECISIONS.md + PRD §10)
- Standalone service + bundled LLM (SD-*)
- Extra report formats (HTML/DOCX/XLSX/PDF)
- Recurring report templates (RG-08)
- Write-back implementation (Q6 — the gate contract already exists; implementing it needs the admin write allowlist + an approval UI/flow)
- Dry-run/undo are done; multi-root is done

## Conventions to keep
- **Fail closed** everywhere; never smooth over a gap; policy > preferences (tighten-never-loosen).
- Secrets only as `${ENV_REF}`; resolve at point of use, never store/log; args logged by hash only (AU-02).
- No network outside the declared MCP allowlist — everything goes through `NetworkGuard`.
- TypeScript strict, ESM, Node ≥ 22. **Pin `typescript@5.9`** (7.x native compiler has a `@types/node` auto-include bug — see diary 2026-08-17 afternoon).
- Run `npm run typecheck && npm test` after changes; `npm run build` for dist.
- Update `docs/DIARY.md` per work block; keep `README.md` Status section current.

## Suggested first action for the next session
Start **item 1 (CLI/service entry point)**: create `src/sandy.ts` + `src/cli.ts` + `bin`, wire the startup sequence, and get `sandy check` + `sandy run` working end-to-end against an in-process MCP server. That unblocks the plugin (item 2) and the conformance test (item 3), which both attach to it.
