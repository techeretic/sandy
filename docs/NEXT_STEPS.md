# Next Steps — Resume Point

_Last updated 2026-08-20. Read this together with `docs/DIARY.md` (chronological log) and `docs/DECISIONS.md` (resolved open questions)._

## Status

**Phase 1 is functionally complete.** The core library is built, tested, composed into a runnable `sandy` binary, wired into a Claude Code / Codex plugin, both conformance gates pass, and the model-engine seam is wired (126/126 tests + conformance, typecheck + build green). The launch success criterion — "zero network egress outside declared MCP endpoints" — is proven in-process and at the network level in Docker, **and the enforcer is proven runtime-agnostic**: the same config + request under Docker and Firejail produce byte-identical behavior (CI matrix). The host LLM is the engine (PL-03) and its token usage is recorded into the audit trail (AU-01) via `sandy.model.usage`. What remains is **Phase 2** (standalone service + bundled LLM behind the `LlmEngine` seam).

Commits so far (oldest → newest):
- `fa61dc5` config layer (Zod schemas + fail-closed loader)
- `a41fb93` Sandbox Enforcer
- `d02371e` MCP Client Manager
- `7e2609a` File Manager
- `42db211` Audit Logger + Orchestrator
- `9da1bd0` CLI / service entry point
- `17cdb8b` Claude Code / Codex plugin (`src/plugin/` + `plugin/`)
- `8dd9c14` egress conformance test: `conformance/` (+ `egress_blocked` audit wiring)
- `c682247` sandbox conformance matrix (Docker + Firejail, CI) + `inFirejail` detection fix
- (this session) model-engine seam: `src/engine.ts` (`LlmEngine`/`HostLlmEngine`), `sandy.model.usage` tool (AU-01)

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
| Plugin (host tools) | `src/plugin/` | `tools.ts` (Zod tool-surface contract), `state.ts` (`PluginSession`/`SessionCache`/`ProgressCollector`), `api.ts` (`SandyPluginAPI` — validate → delegate → shape, confirmation flow, structured errors), `mcp-server.ts` (MCP stdio server exposing 10 `sandy.*` tools incl. `sandy.model.usage`). `plugin/.claude-plugin/plugin.json` + `plugin/install.sh` (manual install, Q3) |
| LLM Engine | `src/engine.ts` | The reasoning-layer seam (PRD §7). `LlmEngine` interface (`record` for AU-01 + `invoke` for the model); `HostLlmEngine` (Phase 1 plugin mode — the host is the engine, records token usage, never invokes); `createLlmEngine` factory fails closed for `local`/`remote` (Phase 2, SD-02/04) |
| Conformance | `conformance/` | `egress.test.ts` (in-process) + `run-docker.sh`/`ep-server.mjs` (Docker network-level egress) + `sandbox-matrix.sh`/`signature.mjs`/`stdio-server.mjs` (Docker + Firejail runtime-agnosticity matrix, SB-10) + `Dockerfile` (shared image). CI: `.github/workflows/ci.yml` |

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

### 3. Egress conformance test (launch success criterion) — DONE (2026-08-18, Docker)
Proved "zero network egress outside declared MCP endpoints" (SB-09; PRD §11/§12) two ways. See `docs/DIARY.md` 2026-08-18 for the full write-up.
- **In-process** (`conformance/egress.test.ts`, always runs): every dialed URL is the declared endpoint; an undeclared endpoint is refused before the dial; an egress block is recorded as `egress_blocked` (AU-01); a full `createSandy` run keeps all egress on the one endpoint; the loader fails closed on a config-time VPN-02 violation.
- **Network-level, Docker** (`conformance/run-docker.sh` + `Dockerfile`): a Docker `--internal` network gives the sandbox a runtime-enforced zero-external-egress boundary. The declared endpoint is an EP container (logs each hit); asserts `sandy run` succeeds + the EP is hit, an external-egress probe is BLOCKED, and an undeclared endpoint fails closed (VPN-02) with nothing leaving.
- Wired: `npm run conformance` (in-process + Docker). **Firejail** is the same harness with the boundary command swapped (enforcer is runtime-agnostic) — see item 4, since firejail isn't installed in this environment.

### 4. Sandbox conformance (SB-09/10) — DONE (2026-08-20)
Proved the enforcer is runtime-agnostic: the same config + request under Docker and Firejail produce **byte-identical behavior**. See `docs/DIARY.md` 2026-08-20. Delivered:
- **Detection fix (a real bug the matrix surfaced):** real firejail sets `container=firejail` (not `FIREJAIL=1` / `/.firejail`), which the detector missed — so a firejail jail on a Docker host was mis-detected and a `firejail` config was wrongly refused. `inFirejail` now recognizes the real signal and is checked before docker (nested jails report the inner boundary). +4 tests incl. the nested case.
- **`conformance/sandbox-matrix.sh`** — runs the same `sandy check`+`run` under both boundaries (Docker `--network none`, Firejail `--net=none` non-root) and asserts each is healthy + the two boundaries' **behavior signatures are byte-identical**. Modes: `SANDY_MATRIX=docker|firejail` (one leg) or both + cross-check; `SANDY_REQUIRE=1` fails closed on a missing boundary (CI), else it skips.
- **`conformance/signature.mjs`** — the runtime-agnostic projection (capability decision, egress allowlist, MCP fleet, provenance `argsHash`); deliberately excludes runtime-specific fields (detected runtime + evidence, absolute paths, timestamps, durations).
- **`conformance/stdio-server.mjs`** — stdio MCP fixture (no network, so the matrix isolates boundary behavior from egress).
- **`.github/workflows/ci.yml`** — `core` (typecheck/build/test + in-process conformance) → `conformance` matrix (docker + firejail, fail-closed, upload signature) → `identity` (download both, require byte-identical).
- **Scripts:** `npm run conformance` now includes the sandbox matrix; `conformance:sandbox` / `:docker` / `:firejail` for single legs.
- **Verified locally with both boundaries present:** both conform, signatures identical, skip/require paths correct, egress harness still green. **121/121 tests** (was 117).

### 5. Model engine wiring — DONE for Phase 1 (plugin mode), 2026-08-20
- **Plugin mode (delivered):** the host LLM is the engine (PL-03). `src/engine.ts` defines the `LlmEngine` seam (PRD §7 "LLM Engine"): `record()` writes a `model_invocation` audit event with token counts (AU-01) and `invoke()` is the model-call point. `HostLlmEngine` is the Phase 1 impl — it records host-reported usage and throws a clear error if asked to `invoke()` (the host reasons outside Sandy). The host feeds its usage via the new **`sandy.model.usage`** tool (10th host tool). The `LlmEngine` interface is the fixed seam a Phase 2 model drops in behind; `createLlmEngine` **fails closed** for `local`/`remote` (SD-02/04, Phase 2) until they're built.
- **Standalone mode (Phase 2, still deferred):** bundle a 4–8B model behind `LlmEngine.invoke()` (SD-02/04). Out of scope for Phase 1.

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
**Phase 1 is complete** (CLI, plugin, egress conformance, sandbox conformance matrix, and the model-engine seam all pass). The next work is **Phase 2 — the standalone service** (SD-01..SD-06). **A design/ADR is drafted in `docs/PHASE2_DESIGN.md`** — read it first; it makes the core calls (same runtime spine + autonomous loop + loopback REST API; llama.cpp as a subprocess behind the `LlmEngine` seam) and lists the open decisions (§7: model/runtime distribution, default model, config field names, API surface, where the model sits in the sandbox). Once those are approved, build in the order in §8: `LlmEngine` local backend (with a `StubEngine` so CI runs with no model) → config extension → autonomous loop → local API → service lifecycle → standalone conformance.
