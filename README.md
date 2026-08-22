# Sandy — SANDBOXable AI Assistant

A sandboxable AI assistant that operates within any sandbox environment, communicates exclusively through MCP servers, and never violates VPN or sandbox security policies.

## Problem

Knowledge workers inside enterprise VPNs cannot use hosted AI assistants against internal systems. Data egress rules, sandbox policies, and network segmentation block the tools that would otherwise save hours of manual information gathering and report writing.

## What Sandy Does

- **Gathers information** from internal workplace services via MCP servers (CRM, Jira, databases, wikis, observability tools, etc.)
- **Produces structured reports** with full data provenance — every claim traceable to its source
- **Manages files and folders** within the sandbox boundary (create, edit, delete)
- **Runs inside any sandbox** — Docker, WSL, Firejail, gVisor, and more
- **Never escapes** — all network I/O flows through declared MCP servers; filesystem access is confined to a configured working root

## Deployment Modes

| Mode | Status | Description |
|------|--------|-------------|
| **Plugin** | Phase 1 | Installs into Claude Code or GitHub Codex. Host LLM handles reasoning; Sandy handles sandboxed execution, MCP communication, and file operations. |
| **Standalone** | Phase 2 | Runs as a local background service with a bundled small LLM (4–8B class) for fully air-gapped deployment. |

## Architecture

```
User (CLI / Claude Code / Codex)
        │
        ▼
┌──────────────────────────────────┐
│           Sandy Service           │
│  Request Parser → Orchestrator    │
│  Task Router → MCP Client Manager │
│  File Manager  → Sandbox Enforcer │
└──────────────┬───────────────────┘
               │ MCP protocol
               ▼
┌──────────────────────────────────┐
│       Sandbox Boundary            │
│  MCP Servers → Internal Services  │
└──────────────┬───────────────────┘
               │
               ▼
          Workplace VPN
```

## Key Principles

- **MCP-only communication** — all interaction with external services goes through declared MCP servers. No raw HTTP/gRPC/SSH.
- **VPN-safe** — never bypasses, tunnels around, or violates VPN routing rules.
- **Sandbox-agnostic** — portable across sandbox implementations. Conformance is expressed as a capability manifest, not per-platform code.
- **Least privilege** — only accesses explicitly configured paths, network endpoints, and MCP servers.
- **Auditable** — structured, append-only audit log for every operation.

## Using Sandy

**Prereq:** build once — `npm ci && npm run build`. Then run from **inside a sandbox** (Sandy refuses to start without a boundary).

**CLI:**
```bash
node bin/sandy.js check  --config config/sandy.json     # validate config + capability/health report
node bin/sandy.js run <request.json> --config config/sandy.json   # gather → provenance-tracked report
# add --json for machine-readable output, --audit <path> to persist the JSONL log
```

**Standalone (bundled model, air-gapped):** first provision the model + runtime (out-of-band, see `docs/MODEL.md`), then set `mode: "standalone"` and point `llm` at the model. The model runs **inside** the sandbox on loopback (zero egress).
```bash
bash scripts/provision-model.sh                          # install llama-server + the default model (prints the "llm" block)
node bin/sandy.js ask "Summarize the EMEA deals" --config sandy.json   # model plans → gathers → reports → narrates
node bin/sandy.js serve --config sandy.json              # long-lived loopback-only service (REST + SSE)
```

**Plugin (Claude Code / Codex):** the host LLM does the reasoning; it calls the `sandy.*` tools over MCP.
```bash
./plugin/install.sh --dir <your-host-plugin-dir>   # manual install (no registry)
# The plugin declares 'sandy' as a stdio MCP server (plugin/.claude-plugin/plugin.json)
# and reads 'sandy.json' from the working directory (or $SANDY_CONFIG).
```
Host tools exposed: `sandy.gather`, `sandy.report`, `sandy.status`, `sandy.model.usage`, and `sandy.files.read|list|write|delete|mkdir|rename`.

**Conformance (the egress + runtime-agnostic guarantees):**
```bash
npm run conformance          # in-process + Docker egress + Docker/Firejail sandbox matrix
npm run test:conformance     # in-process only (no Docker needed)
npm run conformance:docker   # Docker network-level egress proof
npm run conformance:sandbox  # Docker + Firejail sandbox matrix (identical-behavior proof)
```

## Documentation

| Document | Description |
|----------|-------------|
| [PRD Final](docs/PRD_Final.md) | Merged, authoritative product requirements document |
| [PRD Original](docs/PRD.md) | Initial product requirements document |
| [PRD Claude](docs/PRD_Claude.md) | Claude-contributed product requirements |
| [Phase 2 Design](docs/PHASE2_DESIGN.md) | Standalone service + bundled LLM (SD-01..06) — architecture, model backend, local API, decisions |
| [Model Provisioning](docs/MODEL.md) | How to install `llama-server` + the default model, the documented default model, and the resource-limit decision |

## Status

**Phase 1 and Phase 2 are complete, and the real bundled model is proven end-to-end.** Phase 1 (plugin mode) and Phase 2 (the standalone service + bundled LLM, design §8 steps 1–6) are all built, tested, and conformance-proven — and a **real** bundled model (Qwen3-4B-Instruct-2507, Vulkan/GPU) has now been run through the full `sandy ask` loop **inside a no-egress sandbox**: the model planned (validated against the policy's legal tool catalog), the MCP tool ran, a provenance-tracked report was written, the model narrated (clearly labeled, SD-06), usage was audited, and the model process was reaped (no orphan). See `docs/MODEL.md` (provisioning + the documented default model) and `docs/PHASE2_DESIGN.md` §7 (the settled distribution / default-model / resource-limit decisions). Delivered so far:

- Decisions on all open PRD questions (`docs/DECISIONS.md`)
- TypeScript/Node scaffold with config layer: Zod schemas + fail-closed loader for `sandy.json` / `mcp-servers.json` (env-ref-only secrets, exact version pins, VPN-02 egress cross-check, strict/FM-04 policy floors)
- Sandbox Enforcer (`src/sandbox/`): runtime detection (Docker, K8s, Firejail, WSL, gVisor), real-path-based path confinement with symlink-escape refusal (SB-06), declarative capability manifest with reduced-mode reporting (SB-04/05), and a NetworkGuard egress choke point (SB-07/VPN-02)
- MCP Client Manager (`src/mcp/`): multi-server lifecycle over the official MCP SDK (stdio / SSE / streamable-HTTP), startup validation with explicit degraded/unreachable health (MCP-03/09), per-server tool allowlists enforced pre-wire (MCP-07), retries with backoff (MCP-11), terminal-and-explicit startup failures (MCP-10), and args-by-hash audit records (MCP-12). All HTTP egress flows through the NetworkGuard.
- File Manager (`src/files/`): confined file/directory CRUD (FM-01/02/03), policy-gated confirmations (FM-04), undo journal with subtree snapshots (FM-05), dry-run (FM-06), ignore patterns (FM-07), and format-aware write validation for text/CSV/JSON/Markdown (FM-08).
- Audit + Orchestrator (`src/audit/`, `src/orchestrator/`): structured append-only audit log with opt-in payload logging and JSONL persistence (AU-01/02), session transcript export (AU-03), multi-source fan-out with bounded concurrency (RG-01), provenance-tracked claims with a deterministic Markdown report and explicit gaps — never fabricated filler (RG-02/04/05/06), streaming progress events (Q4), and the write-approval gate contract for future write-back (Q6).
- **CLI / service entry point** (`src/sandy.ts`, `src/cli.ts`, `bin/sandy.js`): a runnable `sandy` binary that composes all of the above. `sandy check` validates config and prints the capability/health report; `sandy run <request.json>` executes an orchestrator request (gather → provenance-tracked report); `sandy ask "<goal>"` (standalone) lets the bundled model plan, run, and narrate; `sandy serve` runs the long-lived standalone service (eager model start, loopback API, graceful shutdown). All take `--json` and stream progress to stderr. Fail-closed startup (refuses unsandboxed / runtime mismatch); stable exit codes for CI.
- **Claude Code / Codex plugin** (`src/plugin/`, `plugin/`) — the Phase 1 flagship (PL-01..PL-04). The host LLM does the reasoning; Sandy is exposed as ten host-side tools over MCP — `sandy.gather`, `sandy.report`, `sandy.status`, `sandy.model.usage`, and `sandy.files.read|list|write|delete|mkdir|rename` — all executing inside the sandbox. Bodies are schema-validated, confirmation-gated file ops return `needsConfirmation` (never auto-confirmed), and every op reports structured results. `sandy.model.usage` lets the host (the engine) report its token usage into the audit trail (AU-01). Ships as a Claude Code MCP plugin with a `.claude-plugin/plugin.json` manifest + manual install script (no registry).
- **Egress conformance** (`conformance/`) — the launch success criterion (SB-09). Proves "zero network egress outside declared MCP endpoints" in-process (every dialed URL is the declared endpoint; blocks are refused pre-dial and audited as `egress_blocked`) **and** at the network level in Docker (a `--internal` network boundary; the run succeeds against the one declared endpoint, an external-egress probe is blocked, and an undeclared endpoint fails closed). Run with `npm run conformance`.
- **Sandbox conformance matrix** (`conformance/sandbox-matrix.sh`, `signature.mjs`) — proves the enforcer is **runtime-agnostic** (SB-10): the same config + request run under Docker and under Firejail produce **byte-identical behavior** (capability decision, egress allowlist, MCP fleet outcome, and provenance). Runs in a CI matrix (`.github/workflows/ci.yml`). Both conformance harnesses are **parameterized** (`SANDY_MODE=standalone`) and a `conformance/stub-model.mjs` loopback stand-in for the bundled model makes `sandy ask` run the full loop under both boundaries with no model, no GPU, and no external egress — so the no-egress / cross-sandbox guarantees are proven for **standalone** mode too (SD-05/06). Along the way it fixed a real detection bug: real firejail sets `container=firejail`, which the detector now recognizes (a firejail jail on a Docker host reports firejail, not the inherited docker).
- **LLM Engine seam** (`src/engine.ts`) — the reasoning layer (PRD §7), now with a **lifecycle contract** (`start`/`isReady`/`status`/`close`). In plugin mode the **host LLM is the engine** (`HostLlmEngine`): it records the host-reported token usage into the audit log (AU-01) via the `sandy.model.usage` tool, and never invokes a model itself. For Phase 2 the seam is no longer a stub: `LlamaCppEngine` (SD-02) drives a llama.cpp `llama-server` subprocess on loopback (fail-closed on a missing model, usage recorded, a crash is a reported `degraded` state, the sandbox CPU cap mapped to a real `--threads` budget), `RemoteEngine` (SD-04) calls a declared endpoint through the NetworkGuard, and `StubEngine` makes the standalone path testable in CI with no model/GPU. `createLlmEngine` builds all of them; a `degraded` engine flips `sandy check`'s `ok` to false, and `Sandy.close()` reaps the model process. **Proven against a real model:** `LlamaCppEngine` pipes and drains both of the server's streams and matches its listen URL to discover the port (the real `llama-server` logs to stderr, not stdout), so a real GPU/CPU `llama-server` starts, serves, and is reaped cleanly in-sandbox.
- **Autonomous reasoning loop** (`src/standalone/loop.ts`) — the standalone-mode brain (design §2.1): a natural-language goal is turned by the bundled model into a gather plan, validated against the request schema **and** the manifest's legal tool catalog (the model proposes, the schema disposes), run through the unchanged orchestrator, then narrated into a clearly-labeled report summary. The parse is **bounded** (≤3 attempts, the error fed back) with a **deterministic** conservative fallback or refuse-and-report — never unbounded, never an invented plan. A dead model degrades, never crashes; every model call is audit-logged. Exposed as `sandy ask "<goal>"` (`Sandy.ask` / `Sandy.loop`); it fails closed against the host engine (plugin mode is the host's to plan).
- **Local API + service** (`src/standalone/api.ts`, `sandy serve`) — the standalone service (SD-01/03): a **loopback-only** `node:http` REST API (off-loopback bind refused fail-closed) over the composed `Sandy`. `GET /health` → the check report (incl. engine health), `POST /run` / `POST /ask` → `202` + job id, `GET /jobs/:id` → status/result, `GET /reports`, `GET /audit` (transcript), and SSE `GET /jobs/:id/events` for streaming progress. The job store is **bounded** (max pending → `429`; completed retention with oldest-evicted → clean `404`), and jobs run serially so progress is unambiguous. `sandy serve` starts the model eagerly and shuts down gracefully on SIGINT/SIGTERM (API → in-flight job → model → MCP → audit flush); a dead model is a reported `degraded` state, not a crash.
- **Model + runtime provisioning** (`scripts/provision-model.sh`, `docs/MODEL.md`) — the install-time, out-of-band step that installs `llama-server` (Vulkan build — GPU accel with no CUDA toolkit) and the documented default model (Qwen3-4B-Instruct-2507 Q4_K_M, Apache-2.0, **SHA256-pinned, fail-closed on mismatch**), then prints the ready-to-paste `llm` config block. The runtime itself never downloads a model.
- Example configs in `config/`, test suite (`npm test`) — 169 tests passing

Next: **Phase 1, Phase 2, and the real-model end-to-end are complete** — the full standalone service (model backends, autonomous loop, loopback API + `sandy serve`, service lifecycle, and standalone conformance) is built, tested, conformance-proven for both plugin and standalone modes, and validated with a **real** bundled model inside a no-egress sandbox. The design §7 decisions (distribution, default model, resource-limit scope) are settled with code. Remaining directions: the still-deferred product items (write-back, extra report formats, recurring templates). See `docs/PHASE2_DESIGN.md`, `docs/MODEL.md`, and `docs/NEXT_STEPS.md`.

## License

TBD
