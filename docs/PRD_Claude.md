# **Sandy — Product Requirements**

## **Problem**

Knowledge workers inside enterprise VPNs cannot use hosted AI assistants against internal systems. Data egress rules, sandbox policies, and network segmentation block the tools that would otherwise save hours of manual information gathering and report writing. Existing assistants assume open internet access and unrestricted filesystem reach.

## **Product Summary**

Sandy is a sandbox-native work assistant that runs as a local service on a machine already inside the trust boundary. It reaches internal services only through declared MCP servers, operates on the local filesystem within an explicitly granted scope, and produces reports, summaries, and documents from what it gathers. It ships in two forms: a plugin for Claude Code / Codex, and a standalone service that bundles a small local model for fully air-gapped deployment.

## **Goals**

* Operate correctly inside any sandbox without requiring exceptions to that sandbox's rules  
* Make every outbound call auditable and attributable to a declared MCP server  
* Gather from multiple internal systems and synthesize into a single deliverable  
* Manage files and folders under user direction within a bounded working root  
* Degrade gracefully: same UX whether backed by a frontier model or a bundled small one

## **Non-Goals**

* Acting as a general coding agent (Claude Code already does this)  
* Writing to internal systems in v1 — read-and-report only  
* Managing VPN connectivity, credentials issuance, or MCP server authorship  
* Hosting or serving anything on a public network interface

## **Users**

**Primary:** analysts, engineers, PMs, and support leads inside VPN-restricted enterprises who need to pull from Jira, Confluence, internal wikis, databases, and observability tools to produce recurring reports.

**Secondary:** platform teams who must approve, deploy, and audit the tool; compliance owners who need to prove no data left the boundary.

## **Core Requirements**

### **1\. Sandbox conformance**

* Sandy declares its full capability surface at startup: filesystem roots, network destinations, subprocess needs. If the sandbox denies any, Sandy starts in a reduced mode and reports what it lost rather than failing opaquely.  
* No dynamic capability escalation at runtime. Nothing is requested that wasn't declared.  
* Filesystem access is confined to a configured working root plus explicit user-granted paths. Symlink traversal out of the root is refused.  
* All network I/O goes through the MCP transport layer. Sandy has no general HTTP client available to the model.  
* Runs unprivileged. No daemon on a listening port beyond a loopback-bound local socket for the plugin/UI to attach to.  
* Portable across sandbox implementations: containers, gVisor, seccomp/AppArmor profiles, macOS sandbox-exec, Windows AppContainer. Conformance is expressed as a capability manifest, not per-platform code.

### **2\. MCP as the sole integration path**

* Every internal service is reached via an MCP server declared in config. No ad-hoc connectors.  
* Server registry is admin-controlled and read-only to the user at runtime — users select from approved servers, they don't add them.  
* Per-server allowlist of tools. A server may expose ten tools; the deployment may permit three.  
* Credentials are resolved by the MCP server itself or by the host OS keychain. Sandy never stores or logs secrets, and never places them in model context.  
* Server health surfaced explicitly: unreachable, auth-expired, degraded. Failures never silently produce partial reports without saying so.  
* Connection failures are terminal for that data source, not a prompt for the model to work around.

### **3\. Information gathering and reporting**

* Multi-source retrieval: a single user request can fan out across several MCP servers.  
* Provenance tracking: every claim in a generated report carries a reference to the source tool call that produced it. Reports are inspectable — the user can expand any statement to see the underlying data.  
* Explicit gap reporting. If a source was unreachable or a query returned nothing, that appears in the output rather than being smoothed over.  
* Output formats: Markdown, HTML, DOCX, XLSX, PDF. Format selected by user or inferred from the request.  
* Templates for recurring reports — a saved request that can be re-run on a schedule or on demand against fresh data.  
* No fabrication when a source is missing. A report with holes is correct; a report with invented filler is a product failure.

### **4\. Filesystem operations**

* Create, read, edit, move, and delete files and directories under the working root.  
* Delete and overwrite require confirmation by default; policy can make this stricter, never looser.  
* All mutations journaled with before/after state for the session, enabling undo of the last N operations.  
* Dry-run mode showing the planned filesystem changes before execution.  
* Configurable ignore patterns so Sandy doesn't traverse or modify build artifacts, VCS internals, or secret files.

### **5\. Deployment modes**

**Plugin mode (v1):** Sandy installs into Claude Code or Codex. Inference is handled by the host tool's model; Sandy contributes the MCP orchestration layer, sandbox conformance, report generation, and file operations. This is the fastest path to usable and should ship first.

**Standalone service mode (v2):** Sandy runs as its own local service with a bundled small model (target: 4–8B class, quantized, CPU-viable with GPU acceleration when present) for environments where no external model call is permitted at all. Same MCP layer, same report pipeline, same file semantics. The bundled model is expected to be weaker at synthesis — the product compensates with more structured prompting, more deterministic report scaffolding, and narrower task scope. Model is swappable via config so deployments can substitute their own internally-hosted endpoint.

Behavioral parity is a hard requirement on tool invocation and file operations. Report quality is expected to differ and should be communicated to the user.

### **6\. Audit and observability**

* Structured, append-only local audit log: every MCP call with server, tool, arguments hash, timestamp, outcome; every filesystem mutation; every model invocation with token counts.  
* Logs are readable by the platform team without exposing retrieved payload contents by default; payload logging is an opt-in policy flag.  
* Session transcript exportable as an artifact accompanying any generated report.

### **7\. Configuration and policy**

* Single declarative config file, version-controllable, deployable by the platform team.  
* Policy layer separate from user preferences. Users cannot relax policy.  
* Policy covers: permitted MCP servers and tools, filesystem roots, confirmation thresholds, output formats, model backend, logging verbosity.  
* Config validation on startup with clear errors — a malformed policy fails closed.

## **Success Criteria**

* Sandy runs unmodified under at least three distinct sandbox implementations  
* Zero network egress outside declared MCP endpoints, verifiable by network-level audit  
* A user can produce a multi-source report without leaving their sandboxed environment  
* Platform teams can approve a deployment by reviewing the config file alone  
* Time to produce a recurring report drops meaningfully versus manual gathering

## **Open Questions**

* Should Sandy support write-back to internal systems in a later version, and what approval model would that need?  
* How are MCP server versions pinned and updated within a locked-down deployment?  
* What is the minimum viable bundled model size where report quality remains acceptable?  
* Multi-user: is one Sandy instance per user, or a shared service with per-user scoping?  
* How does Sandy handle long-running gathering tasks that exceed a session — background execution, or explicit resumption?
