# Next Steps — Resume Point

_Last updated 2026-08-18. Read this together with `docs/DIARY.md` (chronological log) and `docs/DECISIONS.md` (resolved open questions)._

## Status

The **core library is built, tested, composed into a runnable `sandy` binary, and wired into a Claude Code / Codex plugin** (112/112 tests, typecheck + build green). The Phase 1 flagship is now in place: the host LLM reasons, and Sandy executes the nine `sandy.*` host-side tools inside the sandbox. The remaining launch work is the conformance gate (egress + sandbox, items 3/4).

Commits so far (oldest → newest):
- `fa61dc5` config layer (Zod schemas + fail-closed loader)
- `a41fb93` Sandbox Enforcer
- `d02371e` MCP Client Manager
- `7e2609a` File Manager
- `42db211` Audit Logger + Orchestrator
- `9da1bd0` CLI / service entry point: `src/sandy.ts` + `src/cli.ts` + `bin` + `src/orchestrator/request.ts`
- (uncommitted) Claude Code / Codex plugin: `src/plugin/` + `plugin/` manifest + install

## What's built (do not rebuild)

| Module | Path | Covers |
|--------|------|--------|
| Config | `src/config/` | `sandy.json` + `mcp-servers.json` schemas, fail-closed loader, env-ref-only secrets, version pins, VPN-02 cross-check |
| Sandbox Enforcer | `src/sandbox/` | runtime detection, real-path path confinement (symlink-escape refusal), capability manifest + reduced-mode report, NetworkGuard egress choke point |
| MCP Client Manager | `src/mcp/` | multi-server lifecycle (stdio/sse/http), startup validation, per-server tool allowlists (pre-wire), retries/backoff, terminal failures, args-by-hash audit; all HTTP through NetworkGuard |
| File Manager | `src/files/` | confined CRUD, confirmation gates, undo journal (+subtree snapshots), dry-run, ignore patterns, format validation (text/csv/json/md) |
| Audit | `src/audit/` | append-only structured log (in-memory + JSONL), opt-in payloads, sink bridges, session transcript export |
| Orchestrator | `src/orchestrator/` | bounded fan-out, provenance claims, explicit gaps, Markdown report renderer, progress events, write-gate contract (ReadOnlyGate); `request.ts` Zod request schema (shared CLI/plugin) |
| Sandy (composition) | `src/sandy.ts` | `createSandy(deps)` startup factory: config → enforcer → audit → MCP → files → orchestrator; `check()` report, `run()`, `close()`. Injectable transport/detection for tests |
| CLI | `src/cli.ts`, `bin/sandy.js` | `sandy check` + `sandy run <request.json>`; `--json`/`--no-progress`/`-c`/`-o`; stable exit codes (0 ok / 1 error / 2 usage / 3 config / 4 sandbox) |
| Plugin (host tools) | `src/plugin/` | `tools.ts` (Zod tool-surface contract), `state.ts` (`PluginSession`/`SessionCache`/`ProgressCollector`), `api.ts` (`SandyPluginAPI` — validate → delegate → shape, confirmation flow, structured errors), `mcp-server.ts` (MCP stdio server exposing 9 `sandy.*` tools). `plugin/.claude-plugin/plugin.json` + `plugin/install.sh` (manual install, Q3) |

Everything is exported from `src/index.ts`. Tests live in `tests/` (use `tests/helpers/mcp.ts` for in-process MCP servers).

## Remaining work, in order

### 1. CLI / service entry point — DONE (2026-08-18)
Composed the modules into a runnable `sandy` binary (the spine the plugin attaches to). See `docs/DIARY.md` 2026-08-18 for the full write-up. Delivered:
- `src/sandy.ts` — `createSandy(deps)`: config → enforcer → audit → MCP → files → orchestrator. Throws fail-closed on invalid config / unsandboxed / runtime mismatch; a *degraded* sandbox or failed MCP server is reported (via `check()`), not thrown. `check()`, `run()`, `close()`.
- `src/orchestrator/request.ts` — Zod `orchestratorRequestSchema` + `toOrchestratorRequest` (shared wire format for CLI + plugin).
- `src/cli.ts` + `bin/sandy.js` + `bin` in `package.json` — `sandy check`, `sandy run <request.json>`, `--json`/`--no-progress`/`-c`/`-o`; exit codes 0/1/2/3/4. Progress on stderr, results on stdout.
- **Fixed a real leak:** `ManagedServer` now closes the transport on a failed connect (a failed stdio connect was orphaning its child process and hanging the process on exit).
- Verified end-to-end against a real stdio MCP subprocess: `check --json` reports healthy; `run` streams progress, returns a provenance claim, writes the report to the confined `reports/` dir, and persists a JSONL audit.

### 2. Claude Code / Codex plugin (PL-01..PL-04) — DONE (2026-08-18)
The Phase 1 flagship. The host LLM does the reasoning (PL-03); Sandy is exposed as a small set of host-side tools over MCP (registered with the host, PL-02; named "Sandy", PL-04). See `docs/DIARY.md` 2026-08-18 for the full write-up. Delivered:
- `src/plugin/tools.ts` — the tool-surface contract (Zod schemas + result types): `sandy.gather`, `sandy.report`, `sandy.status`, `sandy.files.read|list|write|delete|mkdir|rename`.
- `src/plugin/state.ts` — `PluginSession`/`SessionCache` (one Sandy per config, reused across a host's many tool calls) + `ProgressCollector` (Q4 progress returned in-band).
- `src/plugin/api.ts` — `SandyPluginAPI`: validates each body (field-level `ToolInputError`), delegates to the composed Sandy, shapes results. Confirmation-gated file ops return `needsConfirmation` (never auto-confirm, FM-04); every file op reports errors as a structured result, never throws to the host.
- `src/plugin/mcp-server.ts` — MCP stdio server registering the nine `sandy.*` tools; entry point `node dist/plugin/mcp-server.js <sandy.json>`.
- `plugin/.claude-plugin/plugin.json` + `plugin/install.sh` — manual install per Q3 (no registry); `package.json` `files` ships `dist`/`bin`/`plugin`.
- Verified: real MCP stdio handshake lists all nine tools and `sandy.status` reports healthy; **112/112 tests** (was 105).
- **Open (deferred):** how the host surfaces `ProgressEvent`s in its UI — collected in-band now; a host that only shows final results sees them on the result object.

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
Start **item 3 (egress conformance test)**: the launch success criterion — prove "zero network egress outside declared MCP endpoints" at the network level in ≥ Docker + Firejail (SB-09). The plugin and CLI are both done and attach to the same `createSandy` spine, so this is the remaining gate before launch.
