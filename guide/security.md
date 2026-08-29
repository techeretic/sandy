# Security Model

This is the document for the operator, security, or compliance owner who needs to **prove** Sandy's guarantees, not just rely on them. It explains what the boundary is, what is confined to it, and where the seams are — including the accepted limitations.

The one-line summary: **Sandy is an untrusted-reasoner / fixed-executor system.** A swappable, never-trusted reasoner (host LLM or local model) proposes a plan of MCP tool calls; a deterministic, sandboxed, audited executor runs only what a policy allows, inside a boundary it proves it cannot leave. The blast radius of any bad plan is a few extra *legal* read calls — never an unvalidated request, never an unapproved write, never an escape.

## The guarantees

| # | Guarantee | How it holds |
|---|-----------|--------------|
| 1 | **Refuses to run unsandboxed** | The enforcer detects the boundary at startup and throws if none is found (exit `4`), unless the operator explicitly declared a `custom` boundary they manage. |
| 2 | **Fails closed on a runtime mismatch** | The config is approved for one boundary; a declared/detected mismatch is a startup refusal (a Kubernetes pod is accepted for a `docker` declaration). |
| 3 | **Zero egress outside declared endpoints** | There is no general HTTP client. Every network dial goes through the **NetworkGuard**, which allows only `http(s)` to a `host:port` in `sandbox.allowed_network`. |
| 4 | **Filesystem confined to working roots** | All file work goes through **PathConfinement**, which resolves **real paths** and refuses symlink escapes outside the declared roots. |
| 5 | **Least-privilege tool access** | Per-server `allowed_tools` (the **read allowlist**) is applied *before* a tool is wired, and a request's `server`/`tool` pairs are re-validated against the **legal tool catalog**. The allowlist is enforced twice. |
| 6 | **Read-only by default** | With no `write_allowlist`, the default `ReadOnlyGate` refuses every write. |
| 7 | **Every operation is audited** | An append-only, structured log records MCP calls (by args-hash), file mutations + undos, write attempts + decisions, model invocations, and session lifecycle. |
| 8 | **Secrets are env-refs only** | A literal secret where an env-ref is expected is a config error. Secrets are resolved at point of use, never stored or logged. |
| 9 | **Runtime-agnostic behavior** | The same config + request under Docker and Firejail produce byte-identical behavior (proven in CI, both modes). |

## The Sandbox Enforcer

The enforcer (`src/sandbox/`) is the startup boundary guard. Constructed once at process start, it:

1. **Detects the runtime** — `gvisor`, `firejail`, `docker` (→ `k8s-pod` if the Kubernetes env is present), `wsl`, or `none`. Detection order matters: nested sandboxes report the outermost detectable one (a Firejail jail on a Docker host reports `firejail`).
2. **Builds the capability manifest** — a declarative, serializable record (`sandy.capability-manifest/v1`) of everything Sandy needs: filesystem roots, network endpoints, and the subprocesses (stdio MCP servers) it must spawn. This is what a platform team reviews; no capability is ever requested at runtime beyond what the manifest declares.
3. **Probes the environment** and **reports** — rather than failing opaquely — any loss. Anything declared but unavailable (a missing root, an unresolvable subprocess command) becomes an explicit `lost` entry and the run is marked **degraded / reduced mode**. A degraded state is *reported, not fatal* (exit `0`); the `sandy check` output names exactly what was lost.
4. **Exposes PathConfinement** — the gate all filesystem work must pass.

The two startup refusals (no boundary; runtime mismatch) are the hard fails — everything else degrades gracefully and visibly.

### The NetworkGuard

`src/sandbox/network.ts` is the **only** gate through which the MCP client may open a connection. It is deliberately tiny and pure so its behavior is trivially auditable:

- only `http:` / `https:` are permitted (any other scheme → `disallowed-scheme`);
- the URL's hostname must match a `sandbox.allowed_network` entry;
- **default-port normalization**: the URL parser drops a port equal to the scheme's default (`:443` for https), so the guard reconstructs it. A `host:443` entry matches a default-port https URL; a bare `host` entry authorizes only the default port; `host:8443` matches only `:8443`.

A non-matching dial throws `NetworkEgressError` and is audited (`egress_blocked`).

> **Accepted limitation — DNS rebinding.** The guard matches by **hostname**, not by the resolved/pinned IP. A name whose DNS record changes between the check and the connection could in principle point elsewhere. This is the standard limitation class for hostname allowlists, and it is **accepted, not an oversight**: it is safe under the admin-controlled, internal-DNS trust model this project assumes (the internal DNS resolving the declared endpoints is itself operator-controlled, so "the declared hostname" and "its endpoint" are the same trust boundary). If a deployment ever runs under an **untrusted DNS**, pin the endpoints to IP literals or a pinned-identity proxy rather than relying on hostname matching. See [`docs/DECISIONS.md`](../docs/DECISIONS.md).

### PathConfinement

Every file operation resolves to a **real path** (following symlinks) and is refused if it lands outside a declared working root. This is what stops a symlink inside the workspace from escaping to `/etc/passwd`. `allowed_paths` must be absolute and contain no `..`; `report_output_dir` must be inside them.

## The legal tool catalog (least privilege)

The read allowlist is the ceiling for what *any* request — ad-hoc, templated, or model-planned — may call:

- Each MCP server declares `allowed_tools`, a **subset** of its `capabilities`. The MCP Client Manager applies these **before wiring**, so a tool not on the list is never exposed to the orchestrator at all.
- Every request body (CLI, plugin, API, and the standalone loop's plan) is validated against the **legal tool catalog** — the set of legal `(server, tool)` pairs. "Nothing is legal because it is saved" (a template) or "planned" (a model).
- The standalone loop's **every** planning round passes the same catalog gate, so legality can never loosen in a later round.

## Write-back (Q6)

Write-back is **off by default** and, when enabled, is gated twice:

1. **Admin `write_allowlist`** — a config-level `(server, tool)` allowlist. It is always a **subset of the read allowlist** (an entry naming an unknown server or a non-allowed tool is a `ConfigError` — fail closed). An entry may carry `args`, a JSON Schema fragment the write's args must satisfy (checked with the same semantics as the MCP SDK's `structuredContent`; a malformed constraint fails closed, never a silent no-op).
2. **A per-write approval** — a `WriteApproval` bound to the task, single-use, named (approver + reason), and **time-bound** (`policy.approval_ttl_seconds`, default 1800s, capped at a day; an explicit `expiresAt` may only shorten it). It is consumed on use and can be **revoked** before use — a revoked pair can never approve again.

The gate's refusal reasons are distinct and each is audited: `not-allowed-by-policy`, `args-not-allowed`, `no-approval`, `approval-expired`, `approval-revoked`, `gate-refused`. `Orchestrator.write()` audits **every** attempt and **never retries a refusal** — a write is a terminal, distinct audited event. The plugin surfaces `needsApproval` for legal-but-unapproved tasks so a human can complete the consent step; a *policy* refusal is deliberately never listed, because asking the user cannot make it legal.

**The default posture is read-only**: no `write_allowlist` ⇒ `ReadOnlyGate` ⇒ every write refused.

## The audit log

Append-only, structured, and **fail-closed** (a disk write failure is surfaced to stderr and reported on `close()`, never swallowed). Two backends: in-memory (session-scoped, tests) and **JSONL** (one JSON object per line, ordered). Every event carries a monotonic `seq`, an ISO timestamp, a `type`, and structured `data`.

Event types:

| Type | Records |
|------|---------|
| `mcp_call` | Every MCP call — server, tool, **args hash** (not args), duration, outcome. |
| `file_mutation` | File ops — op, path, outcome, dry-run flag; undos are journaled too. |
| `model_invocation` | Every model call — provider, model, token counts, duration, outcome. |
| `orchestrator_task` | Task-level orchestration outcomes. |
| `write_attempt` | Every write attempt + the gate's decision (incl. approver). |
| `egress_blocked` | A refused network dial (the NetworkGuard's denials). |
| `sandbox_violation` | A boundary violation. |
| `session_start` / `session_end` | The session lifecycle. |
| `standalone_parse` / `standalone_plan` / `standalone_narrate` / `standalone_replan` | The autonomous loop's decisions (plan source, attempts, narrative, re-plan outcome). |
| `template_run` | A run resolved from a saved template. |

**Args are logged by hash by default** (AU-02) — `policy.audit_payload_logging: true` opts into logging full payloads (retrieved data, model prompt/completion). The log is the forensic record: it is what answers "what did it call, with what, when, and what did it change?" The `GET /audit` endpoint and `GET /jobs/:id` expose the **transcript** export.

## Threat model notes

**Untrusted reasoner.** The reasoner (host LLM or local model) is never trusted. It can only propose gather tasks, request a report, and (in standalone) narrate. It cannot touch the network or filesystem directly, call a non-legal tool, escape the sandbox, bypass the write gate, or make an illegal plan legal by retrying.

**Prompt injection via MCP-retrieved content.** The standalone narrate (and re-plan) prompt embeds `claim.text` — content retrieved from internal systems (a Jira body, a wiki page, a CRM note) — which is **untrusted relative to the model**. Mitigations, by design:

- **Claims are the source of truth, independent of the narrative.** The report's Findings/Provenance render directly from claim data with no model involvement; the narrative is a clearly-labeled separate section a reader is told not to treat as the sole source of truth.
- **The narrative cannot expand what already ran.** `narrate()` runs *after* the gather pass, only summarizes collected results, and has no tool-calling ability — it cannot trigger new MCP calls or file ops.
- **A narrate failure degrades gracefully** (the deterministic report stands, no narrative section).

The re-plan step has the same analysis with a strictly bounded blast radius: the decision is only `stop` or a set of gather tasks that pass the same gate as round 1, so the worst case is a few extra *legal* MCP calls within the round cap — never an unvalidated request, never a write. **Accepted residual risk:** a weak local model *could* be steered by injected content into a misleading narrative, even though the underlying claims remain correct and traceable. See [`docs/PHASE2_DESIGN.md`](../docs/PHASE2_DESIGN.md) §2.1 for the full note.

**Ingress (the service).** `sandy serve` is loopback-only by construction: an off-loopback bind is refused fail-closed, non-JSON content types are rejected (`415`), and a foreign `Origin` is rejected (`403`) — independent of CORS. There is no auth in the v1 service because it is loopback-only and single-user; a later need is a config-gated addition, not a default.

## Proving it: conformance

The guarantees are not just asserted — they are **tested**:

- **In-process** egress + sandbox conformance (`npm run test:conformance`) — no Docker needed.
- **Docker network-level egress** (`npm run conformance:docker`) — the declared endpoint is hit, an independent external-egress probe **fails**, and an undeclared endpoint **fails closed at startup**.
- **Docker + Firejail matrix** (`npm run conformance:sandbox`) — the same config + request under both boundaries produce **byte-identical** behavioral signatures, for both plugin and standalone modes (CI).
- **Opt-in real-model leg** (`SANDY_REAL_MODEL=<gguf>`) — the full `sandy ask` loop against the real provisioned GGUF inside a no-egress Firejail jail.

See [Development → Conformance](development.md#conformance) for how to run each.
