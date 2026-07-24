# Sandy — SANdbloxable AI Assistant

## Product Requirements Document

---

### 1. Vision

Sandy is a sandboxable AI assistant that operates within **any** sandbox environment. It runs as a background service on the user's machine, communicates exclusively through **MCP (Model Context Protocol)** servers, and never violates VPN or sandbox security policies. Sandy gathers information from internal workplace services, prepares reports, and manages files and folders — all within the security boundary defined by the user.

Knowledge workers inside enterprise VPNs cannot use hosted AI assistants against internal systems. Data egress rules, sandbox policies, and network segmentation block the tools that would otherwise save hours of manual information gathering and report writing. Existing assistants assume open internet access and unrestricted filesystem reach. Sandy solves this by living natively inside the trust boundary.

---

### 2. Problem Statement

- Workplaces use VPNs, sandboxes, and firewalls to protect internal services.
- AI assistants (Claude, Codex, etc.) run outside these boundaries and cannot safely access internal data.
- There is no AI assistant that can be deployed **inside** a sandbox, communicate via **standardized MCP servers**, and still deliver meaningful work (reports, file management, data gathering).
- Employees need a way to get AI-powered insights from internal services without compromising security.

---

### 3. Users

**Primary:** Analysts, engineers, PMs, and support leads inside VPN-restricted enterprises who need to pull from Jira, Confluence, internal wikis, databases, and observability tools to produce recurring reports.

**Secondary:** Platform teams who must approve, deploy, and audit the tool; compliance owners who need to prove no data left the boundary.

---

### 4. Goals

1. **Sandbox-agnostic**: Work within ANY sandbox — Docker, WSL, chroot, systemd-nspawn, Firejail, Kubernetes pods, gVisor, macOS sandbox-exec, Windows AppContainer, or custom.
2. **MCP-only communication**: All interaction with external services happens through MCP servers. No raw HTTP/gRPC/SSH unless mediated by an MCP server.
3. **VPN-safe**: Never bypass, tunnel around, or violate VPN routing or security rules.
4. **Dual deployment**: Run as a standalone service (with bundled LLM) or as a plugin within Claude Code / Codex.
5. **File management**: Create, edit, delete files and folders within the sandbox.
6. **Report generation**: Gather information from multiple MCP-connected services and produce structured reports with full provenance.
7. **Graceful degradation**: Same UX whether backed by a frontier model or a bundled small one.

---

### 5. Non-Goals

- Building a new LLM model.
- Replacing Claude Code, Codex, or other AI coding tools.
- General-purpose IT automation (Sandy is AI-assisted, not a cron job runner).
- Acting as a general coding agent (Claude Code already does this).
- Writing to internal systems in v1 — read-and-report only.
- Managing VPN connectivity, credentials issuance, or MCP server authorship.
- Hosting or serving anything on a public network interface.

---

### 6. Core Requirements

#### 6.1 — Sandbox Conformance

| ID | Requirement | Priority |
|----|-------------|----------|
| SB-01 | Sandy must run inside a user-defined sandbox with configurable constraints (network, filesystem, processes). | P0 |
| SB-02 | Sandbox configuration must be declarative — a single file that defines what is allowed and what is not. | P0 |
| SB-03 | Sandy must detect its sandbox boundary at startup and refuse operations that would escape it. | P0 |
| SB-04 | Sandy declares its full capability surface at startup: filesystem roots, network destinations, subprocess needs. If the sandbox denies any, Sandy starts in a reduced mode and reports what it lost rather than failing opaquely. | P0 |
| SB-05 | No dynamic capability escalation at runtime. Nothing is requested that wasn't declared. | P0 |
| SB-06 | Filesystem access is confined to a configured working root plus explicit user-granted paths. Symlink traversal out of the root is refused. | P0 |
| SB-07 | All network I/O goes through the MCP transport layer. Sandy has no general HTTP client available to the model. | P0 |
| SB-08 | Runs unprivileged. No daemon on a listening port beyond a loopback-bound local socket for the plugin/UI to attach to. | P0 |
| SB-09 | Sandy must support at least: Docker containers, WSL, and Firejail at launch. | P1 |
| SB-10 | Portable across sandbox implementations: containers, gVisor, seccomp/AppArmor profiles, macOS sandbox-exec, Windows AppContainer. Conformance is expressed as a capability manifest, not per-platform code. | P1 |

#### 6.2 — MCP as the Sole Integration Path

| ID | Requirement | Priority |
|----|-------------|----------|
| MCP-01 | All communication with workplace services must go through MCP servers. No direct protocol calls, no ad-hoc connectors. | P0 |
| MCP-02 | Sandy must load MCP server configurations from a manifest file at startup. | P0 |
| MCP-03 | Sandy must validate MCP server availability and capabilities at startup. | P0 |
| MCP-04 | Sandy must support connecting to multiple MCP servers simultaneously. | P0 |
| MCP-05 | Sandy must handle MCP server authentication (OAuth, API keys, mutual TLS). | P0 |
| MCP-06 | Server registry is admin-controlled and read-only to the user at runtime — users select from approved servers, they don't add them. | P0 |
| MCP-07 | Per-server allowlist of tools. A server may expose ten tools; the deployment may permit three. | P0 |
| MCP-08 | Credentials are resolved by the MCP server itself or by the host OS keychain. Sandy never stores or logs secrets, and never places them in model context. | P0 |
| MCP-09 | Server health surfaced explicitly: unreachable, auth-expired, degraded. Failures never silently produce partial reports without saying so. | P0 |
| MCP-10 | Connection failures are terminal for that data source, not a prompt for the model to work around. | P0 |
| MCP-11 | Sandy must retry failed MCP requests with configurable backoff. | P1 |
| MCP-12 | Sandy must log all MCP server calls for auditability. | P1 |

#### 6.3 — VPN & Network Safety

| ID | Requirement | Priority |
|----|-------------|----------|
| VPN-01 | Sandy must never route traffic outside VPN-sanctioned paths. | P0 |
| VPN-02 | Network egress must be restricted to endpoints declared in the sandbox config. | P0 |
| VPN-03 | Sandy must detect if VPN connectivity is lost and pause operations. | P1 |

#### 6.4 — Information Gathering & Reporting

| ID | Requirement | Priority |
|----|-------------|----------|
| RG-01 | Multi-source retrieval: a single user request can fan out across several MCP servers. | P0 |
| RG-02 | Sandy must synthesize gathered information into structured reports (Markdown, HTML, DOCX, XLSX, PDF). | P0 |
| RG-03 | Sandy must save generated reports to a user-specified directory within the sandbox. | P0 |
| RG-04 | Provenance tracking: every claim in a generated report carries a reference to the source tool call that produced it. Reports are inspectable — the user can expand any statement to see the underlying data. | P0 |
| RG-05 | Explicit gap reporting. If a source was unreachable or a query returned nothing, that appears in the output rather than being smoothed over. | P0 |
| RG-06 | No fabrication when a source is missing. A report with holes is correct; a report with invented filler is a product failure. | P0 |
| RG-07 | Output format selected by user or inferred from the request. | P1 |
| RG-08 | Templates for recurring reports — a saved request that can be re-run on a schedule or on demand against fresh data. | P1 |

#### 6.5 — Filesystem Operations

| ID | Requirement | Priority |
|----|-------------|----------|
| FM-01 | Sandy must create, read, update, and delete files within the sandbox. | P0 |
| FM-02 | Sandy must create, rename, and delete directories within the sandbox. | P0 |
| FM-03 | File operations must be restricted to allowed paths defined in the sandbox config. | P0 |
| FM-04 | Delete and overwrite require confirmation by default; policy can make this stricter, never looser. | P0 |
| FM-05 | All mutations journaled with before/after state for the session, enabling undo of the last N operations. | P1 |
| FM-06 | Dry-run mode showing the planned filesystem changes before execution. | P1 |
| FM-07 | Configurable ignore patterns so Sandy doesn't traverse or modify build artifacts, VCS internals, or secret files. | P1 |
| FM-08 | Sandy must support file operations across multiple formats (plain text, CSV, JSON, Markdown). | P1 |

#### 6.6 — Deployment Modes

**Mode A: Plugin (Claude Code / Codex) — v1**

| ID | Requirement | Priority |
|----|-------------|----------|
| PL-01 | Sandy installs as a plugin within Claude Code and GitHub Codex. | P0 |
| PL-02 | The plugin registers Sandy's capabilities with the host tool. | P0 |
| PL-03 | The host LLM handles high-level reasoning; Sandy handles sandboxed execution, MCP communication, and file operations. | P0 |
| PL-04 | Plugin name is **"Sandy"**. | P0 |

**Mode B: Standalone Service — v2**

| ID | Requirement | Priority |
|----|-------------|----------|
| SD-01 | Sandy runs as a long-lived background service on the host machine. | P0 |
| SD-02 | Sandy bundles a lightweight LLM model (target: 4–8B class, quantized, CPU-viable with GPU acceleration when present) for offline-capable reasoning. | P0 |
| SD-03 | Sandy exposes a local API (REST or CLI) for the user to send requests. | P0 |
| SD-04 | The bundled LLM is swappable — user can configure a different model or remote endpoint. | P1 |
| SD-05 | Same MCP layer, same report pipeline, same file semantics as plugin mode. Model is expected to be weaker at synthesis — the product compensates with more structured prompting, more deterministic report scaffolding, and narrower task scope. | P1 |
| SD-06 | Behavioral parity is a hard requirement on tool invocation and file operations. Report quality is expected to differ and should be communicated to the user. | P1 |

#### 6.7 — Audit & Observability

| ID | Requirement | Priority |
|----|-------------|----------|
| AU-01 | Structured, append-only local audit log: every MCP call with server, tool, arguments hash, timestamp, outcome; every filesystem mutation; every model invocation with token counts. | P0 |
| AU-02 | Logs are readable by the platform team without exposing retrieved payload contents by default; payload logging is an opt-in policy flag. | P1 |
| AU-03 | Session transcript exportable as an artifact accompanying any generated report. | P1 |

#### 6.8 — Configuration & Policy

| ID | Requirement | Priority |
|----|-------------|----------|
| CP-01 | Single declarative config file, version-controllable, deployable by the platform team. | P0 |
| CP-02 | Policy layer separate from user preferences. Users cannot relax policy. | P0 |
| CP-03 | Policy covers: permitted MCP servers and tools, filesystem roots, confirmation thresholds, output formats, model backend, logging verbosity. | P0 |
| CP-04 | Config validation on startup with clear errors — a malformed policy fails closed. | P0 |

---

### 7. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      USER INTERFACE                         │
│              CLI  /  Claude Code  /  Codex                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ natural language requests
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      SANDY SERVICE                          │
│                                                             │
│  ┌─────────────┐   ┌──────────────────┐   ┌──────────────┐ │
│  │  Request     │──>│  Orchestrator    │──>│  Task        │ │
│  │  Parser      │   │                  │   │  Router      │ │
│  └─────────────┘   └──────────────────┘   └──────┬───────┘ │
│                                                  │          │
│                     ┌────────────────────────────┤          │
│                     │                            │          │
│             ┌───────▼──────┐            ┌────────▼──────┐  │
│             │  MCP Client   │            │  File Manager │  │
│             │  Manager      │            │               │  │
│             └───────┬───────┘            └───────────────┘  │
│                     │                                       │
│  ┌──────────────────▼───────────────────┐                   │
│  │         Sandbox Enforcer             │                   │
│  └──────────────────────────────────────┘                   │
└────────────────────────┬────────────────────────────────────┘
                         │ MCP protocol
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    SANDBOX BOUNDARY                          │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │  MCP     │  │  MCP     │  │  MCP     │  │  MCP       │ │
│  │  Server  │  │  Server  │  │  Server  │  │  Server    │ │
│  │  (CRM)   │  │  (Jira)  │  │  (DB)    │  │  (Slack)   │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬───────┘ │
│       │              │              │              │         │
└───────┼──────────────┼──────────────┼──────────────┼─────────┘
        │              │              │              │
        ▼              ▼              ▼              ▼
   ┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐
   │ CRM    │   │ Jira   │   │ Data   │   │ Slack  │
   │ API    │   │ API    │   │ Warehouse│  │ API    │
   └────────┘   └────────┘   └────────┘   └────────┘
        ▲              ▲              ▲              ▲
        └──────────────┴──────────────┴──────────────┘
                   Workplace VPN
```

#### 7.1 — Components

| Component | Responsibility |
|-----------|----------------|
| **Request Parser** | Parses natural language input into structured task definitions. |
| **Orchestrator** | Coordinates multi-step workflows across MCP servers and file operations. |
| **Task Router** | Routes individual tasks to the appropriate handler (MCP or File Manager). |
| **MCP Client Manager** | Manages connections to all registered MCP servers, handles auth, retries, health checks, and lifecycle. |
| **File Manager** | Handles CRUD operations on files and directories within the sandbox. Supports dry-run, undo journal, and confirmation thresholds. |
| **LLM Engine** | Reasoning layer — either the bundled local model (standalone) or the host LLM (plugin mode). |
| **Sandbox Enforcer** | Validates that all operations stay within declared sandbox boundaries. Enforces symlink protection, path confinement, and no-escape rules. |
| **Audit Logger** | Append-only structured logger for all MCP calls, file mutations, and model invocations. |

---

### 8. Configuration Files

#### `sandy.json` — Main Config

```json
{
  "mode": "standalone",
  "llm": {
    "provider": "local",
    "model": "llama-3.1-8b-instruct",
    "api_key": null
  },
  "sandbox": {
    "runtime": "firejail",
    "allowed_paths": ["/home/user/sandy-workspace"],
    "allowed_network": ["internal.company.com:443"],
    "max_memory_mb": 2048,
    "max_cpu_percent": 50
  },
  "mcp_servers": "./mcp-servers.json",
  "report_output_dir": "./reports",
  "policy": {
    "confirmation_required": ["delete", "overwrite"],
    "undo_depth": 10,
    "dry_run_default": false,
    "audit_payload_logging": false,
    "ignore_patterns": ["node_modules/", ".git/", "*.env", ".secret"]
  },
  "preferences": {
    "default_report_format": "markdown",
    "max_concurrent_mcp_calls": 5
  }
}
```

#### `mcp-servers.json` — MCP Server Manifest

```json
{
  "servers": [
    {
      "name": "crm",
      "transport": "stdio",
      "command": ["npx", "-y", "@company/crm-mcp-server"],
      "env": { "CRM_API_KEY": "${CRM_API_KEY}" },
      "capabilities": ["read_deals", "read_contacts"],
      "allowed_tools": ["read_deals", "read_contacts"]
    },
    {
      "name": "jira",
      "transport": "sse",
      "url": "https://internal.company.com/jira-mcp",
      "auth": {
        "type": "bearer",
        "token": "${JIRA_TOKEN}"
      },
      "capabilities": ["read_sprints", "read_issues", "create_issue"],
      "allowed_tools": ["read_sprints", "read_issues"]
    }
  ]
}
```

---

### 9. Security Model

| Principle | Implementation |
|-----------|----------------|
| **Least privilege** | Sandy only accesses explicitly configured paths, network endpoints, and MCP servers. |
| **No escape** | Sandbox enforcer validates every operation against boundary rules. Symlink traversal out of root is refused. |
| **Credential safety** | Secrets are injected via environment variables or a secrets manager — never stored in config files. Sandy never stores or logs secrets, and never places them in model context. |
| **Audit trail** | Every MCP call, file operation, and LLM interaction is logged to an append-only structured audit log. Payload logging is opt-in. |
| **VPN enforcement** | Network calls are restricted to allowlisted endpoints. Egress outside the VPN is blocked by the sandbox. |
| **Policy > Preferences** | Policy layer is separate from user preferences. Users can adjust preferences but cannot relax policy constraints. |

---

### 10. Phase 1 Scope

**Build the MVP as a Claude Code / Codex plugin first.**

- Implement the MCP Client Manager and File Manager.
- Build the Orchestrator to handle multi-step tasks across MCP servers.
- Create the plugin interface for Claude Code and Codex.
- Support 2-3 MCP servers out of the box (e.g., file system, web search, one internal service).
- Generate reports in Markdown format with provenance tracking.
- Full sandbox enforcement with configurable boundaries.
- Admin-controlled MCP server registry with per-server tool allowlists.
- Structured audit logging.
- Read-and-report only — no write-back to internal systems.

**Defer to Phase 2:**

- Standalone mode with bundled LLM.
- Additional output formats (HTML, DOCX, XLSX, PDF).
- Recurring report templates.
- Dry-run and undo support for file operations.

---

### 11. Success Criteria

- Sandy runs unmodified under at least three distinct sandbox implementations.
- Zero network egress outside declared MCP endpoints, verifiable by network-level audit.
- A user can produce a multi-source report without leaving their sandboxed environment.
- Platform teams can approve a deployment by reviewing the config file alone.
- Time to produce a recurring report drops meaningfully versus manual gathering.
- Plugin works seamlessly within Claude Code and Codex.

### 12. Success Metrics

| Metric | Target |
|--------|--------|
| Sandboxes supported at launch | 2 (Docker + Firejail or WSL) |
| MCP servers supported | 5+ |
| Report generation latency (simple query) | < 30 seconds |
| Sandbox escape attempts detected & blocked | 100% |
| Plugin compatibility | Claude Code + Codex |

---

### 13. Open Questions

1. **Which sandbox runtime(s) to prioritize?** Docker is the most portable, but Firejail and WSL cover different user segments.
2. **Standalone LLM size vs. quality tradeoff.** A sub-8B model is fast but may struggle with complex report synthesis. Should we offer tiered models?
3. **MCP server authoring.** Should Sandy include tooling for users to write their own MCP server wrappers for internal services?
4. **Real-time updates.** Should Sandy support streaming responses for long-running queries?
5. **Multi-user support.** Should a single Sandy instance serve multiple users, or is one-instance-per-user the model?
6. **Plugin distribution.** How do we distribute the Claude Code / Codex plugin? Marketplace, npm, manual install?
7. **Write-back to internal systems.** Should Sandy support write-back in a later version, and what approval model would that need?
8. **MCP server versioning.** How are MCP server versions pinned and updated within a locked-down deployment?
9. **Long-running tasks.** How does Sandy handle long-running gathering tasks that exceed a session — background execution, or explicit resumption?
