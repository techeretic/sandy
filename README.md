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

## Status

Phase 1 in progress. Delivered so far:

- Decisions on all open PRD questions (`docs/DECISIONS.md`)
- TypeScript/Node scaffold with config layer: Zod schemas + fail-closed loader for `sandy.json` / `mcp-servers.json` (env-ref-only secrets, exact version pins, VPN-02 egress cross-check, strict/FM-04 policy floors)
- Sandbox Enforcer (`src/sandbox/`): runtime detection (Docker, K8s, Firejail, WSL, gVisor), real-path-based path confinement with symlink-escape refusal (SB-06), declarative capability manifest with reduced-mode reporting (SB-04/05), and a NetworkGuard egress choke point (SB-07/VPN-02)
- MCP Client Manager (`src/mcp/`): multi-server lifecycle over the official MCP SDK (stdio / SSE / streamable-HTTP), startup validation with explicit degraded/unreachable health (MCP-03/09), per-server tool allowlists enforced pre-wire (MCP-07), retries with backoff (MCP-11), terminal-and-explicit startup failures (MCP-10), and args-by-hash audit records (MCP-12). All HTTP egress flows through the NetworkGuard.
- File Manager (`src/files/`): confined file/directory CRUD (FM-01/02/03), policy-gated confirmations (FM-04), undo journal with subtree snapshots (FM-05), dry-run (FM-06), ignore patterns (FM-07), and format-aware write validation for text/CSV/JSON/Markdown (FM-08).
- Audit + Orchestrator (`src/audit/`, `src/orchestrator/`): structured append-only audit log with opt-in payload logging and JSONL persistence (AU-01/02), session transcript export (AU-03), multi-source fan-out with bounded concurrency (RG-01), provenance-tracked claims with a deterministic Markdown report and explicit gaps — never fabricated filler (RG-02/04/05/06), streaming progress events (Q4), and the write-approval gate contract for future write-back (Q6).
- **CLI / service entry point** (`src/sandy.ts`, `src/cli.ts`, `bin/sandy.js`): a runnable `sandy` binary that composes all of the above. `sandy check` validates config and prints the capability/health report; `sandy run <request.json>` executes an orchestrator request (gather → provenance-tracked report) with `--json` and streaming progress. Fail-closed startup (refuses unsandboxed / runtime mismatch); stable exit codes for CI.
- **Claude Code / Codex plugin** (`src/plugin/`, `plugin/`) — the Phase 1 flagship (PL-01..PL-04). The host LLM does the reasoning; Sandy is exposed as ten host-side tools over MCP — `sandy.gather`, `sandy.report`, `sandy.status`, `sandy.model.usage`, and `sandy.files.read|list|write|delete|mkdir|rename` — all executing inside the sandbox. Bodies are schema-validated, confirmation-gated file ops return `needsConfirmation` (never auto-confirmed), and every op reports structured results. `sandy.model.usage` lets the host (the engine) report its token usage into the audit trail (AU-01). Ships as a Claude Code MCP plugin with a `.claude-plugin/plugin.json` manifest + manual install script (no registry).
- **Egress conformance** (`conformance/`) — the launch success criterion (SB-09). Proves "zero network egress outside declared MCP endpoints" in-process (every dialed URL is the declared endpoint; blocks are refused pre-dial and audited as `egress_blocked`) **and** at the network level in Docker (a `--internal` network boundary; the run succeeds against the one declared endpoint, an external-egress probe is blocked, and an undeclared endpoint fails closed). Run with `npm run conformance`.
- **Sandbox conformance matrix** (`conformance/sandbox-matrix.sh`, `signature.mjs`) — proves the enforcer is **runtime-agnostic** (SB-10): the same config + request run under Docker and under Firejail produce **byte-identical behavior** (capability decision, egress allowlist, MCP fleet outcome, and provenance). Runs in a CI matrix (`.github/workflows/ci.yml`). Along the way it fixed a real detection bug: real firejail sets `container=firejail`, which the detector now recognizes (a firejail jail on a Docker host reports firejail, not the inherited docker).
- **LLM Engine seam** (`src/engine.ts`) — the reasoning layer (PRD §7). In plugin mode the **host LLM is the engine** (`HostLlmEngine`): it records the host-reported token usage into the audit log (AU-01) via the `sandy.model.usage` tool, and never invokes a model itself. The `LlmEngine` interface is the fixed seam a Phase 2 bundled/remote model (SD-02/04) drops in behind; `createLlmEngine` fails closed for `local`/`remote` until then.
- Example configs in `config/`, test suite (`npm test`) — 126 tests passing

Next: Phase 2 — standalone service + bundled LLM behind the `LlmEngine` seam (SD-*). Phase 1 is functionally complete: CLI, plugin, egress conformance, and the sandbox conformance matrix all pass.

## License

TBD
