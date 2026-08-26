# Decisions Log

Answers to PRD §13 open questions, captured 2026-08-17.

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Sandbox runtime priority | **Docker + Firejail at launch.** Enforcer is runtime-agnostic (SB-10); WSL/gVisor/etc. are later config-only additions. | Docker is most portable and CI-testable; Firejail covers lightweight host-level Linux. Meets the 2-sandbox launch metric. |
| 2 | Tech stack | **TypeScript/Node.** | First-class MCP SDKs; natural fit for Claude Code / Codex plugin hosts; Phase 2 local model serving via llama.cpp bindings. |
| 3 | Plugin distribution | **Git repo + manual install** for v1. | Platform teams control rollout; no registry dependency in locked-down environments. Revisit marketplace later. |
| 4 | Streaming responses | **Yes — stream progress in v1.** | Better UX for slow multi-source queries; report artifacts remain batch outputs. |
| 5 | Multi-user support | **One instance per user.** | Avoids shared-state auth/audit complexity in v1; per-user config already exists (CP-01). |
| 6 | Write-back to internal systems | **Defer implementation; design the approval-gate architecture now. (Core now implemented — issue #16.)** | Keep v1 read-and-report (PRD non-goal) but shape the Orchestrator/MCP allowlist so a write path can be added behind an approval gate without rework. Delivered: an admin `write_allowlist` (config, always a subset of the read allowlist — CP-02), a `PolicyApprovalGate` (allowlist + single-use, per-write, audited approval), `Orchestrator.write()`, and the `sandy.write` plugin tool. Default stays fail-closed: no `write_allowlist` → `ReadOnlyGate` refuses every write. |
| 7 | MCP server versioning | **Pin exact versions in `mcp-servers.json`; updates are config changes reviewed in VCS.** | Fits the admin-controlled, read-only-at-runtime registry (MCP-06) and locked-down deployments. |
| 8 | Long-running tasks | **Session-scoped only in v1.** | Re-runnable report templates (RG-08, Phase 2) cover the recurring case; no persistence/resumption in v1. |
| 9 | MCP server authoring | **Include scaffolding tools.** | Lets platform teams wrap internal services as MCP servers; ships alongside the config schemas, not in the model's runtime path. |
| 10 | Model + runtime distribution (Phase 2, design §7 #1) | **Docs-based install + `scripts/provision-model.sh` helper** (SHA256-pinned, fail-closed on mismatch). No runtime download. | Install-time, out-of-band step; air-gap-friendly (copy the file over); keeps no download logic in the security-relevant runtime path. |
| 11 | Default bundled model (Phase 2, design §7 #2) | **Qwen3-4B-Instruct-2507, Q4_K_M GGUF** (~2.4GB, Apache-2.0). | An instruct (chat/agent) model in the 4–8B class; license/size check cleared; proven end-to-end in-sandbox with a real `sandy ask`. |
| 12 | Model resource-limit scope (Phase 2, §4.5) | **Map caps to real levers; hard ceiling = service-manager cgroup; opt-in in-service cgroup bound (issue #18).** `max_cpu_percent` → llama.cpp `--threads` budget (`threadsForCpuPercent`); default hard memory bound is the supervisor's cgroup. `sandbox.enforce_memory_limit: true` (default off) additionally wraps the model's process group in a cgroup v2 child with `memory.max` = `max_memory_mb`. | CPU cap is a genuine in-service lever (tighten-never-loosen: 100% = no flag, lower = fewer threads); the default hard memory ceiling belongs to the process supervisor. The opt-in in-service bound needs cgroup delegation and fails closed (degraded engine) where it can't be applied, so it is never silently unbounded. |

## Accepted limitations

- **Egress allowlist matches by hostname, not by resolved/pinned IP (DNS rebinding).** `sandbox.allowed_network` and the `NetworkGuard` (`src/sandbox/network.ts`) authorize egress by the URL's hostname — they do not pin the IP the name resolved to at check time, so a name whose DNS record changes between the allowlist check and the connection could in principle point elsewhere (the standard DNS-rebinding limitation class for hostname allowlists). This is an **accepted limitation, not an oversight**: it is safe under the admin-controlled, internal-DNS trust model this project assumes — the internal DNS that resolves the declared endpoints is itself controlled and trusted by the operator, so "the declared hostname" and "the endpoint it resolves to" are the same trust boundary. If a deployment ever operates under an untrusted DNS, pin the endpoints to IP literals (or run behind a pinned-identity proxy) rather than relying on hostname matching.

## Consequences

- Phase 1 build order: config schemas → Sandbox Enforcer (Docker + Firejail) → MCP Client Manager → File Manager → Orchestrator (streaming progress + write-gate design) → Claude Code / Codex plugin (manual install) → MCP server scaffolding tools.
- `mcp-servers.json` must carry an explicit `version`/pin field per server (Q7).
- Progress streaming is a P1 UX requirement for the plugin interface (Q4).
- The write-approval gate was a design-time deliverable for v1 (Q6); its core (allowlist + `PolicyApprovalGate` + `sandy.write`) is now implemented (issue #16), defaulting to the read-only `ReadOnlyGate` — fail closed, never auto-confirm.
