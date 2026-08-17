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
- Example configs in `config/`, test suite (`npm test`) — 55 tests passing

Next: File Manager.

## License

TBD
