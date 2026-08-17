# Decisions Log

Answers to PRD §13 open questions, captured 2026-08-17.

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Sandbox runtime priority | **Docker + Firejail at launch.** Enforcer is runtime-agnostic (SB-10); WSL/gVisor/etc. are later config-only additions. | Docker is most portable and CI-testable; Firejail covers lightweight host-level Linux. Meets the 2-sandbox launch metric. |
| 2 | Tech stack | **TypeScript/Node.** | First-class MCP SDKs; natural fit for Claude Code / Codex plugin hosts; Phase 2 local model serving via llama.cpp bindings. |
| 3 | Plugin distribution | **Git repo + manual install** for v1. | Platform teams control rollout; no registry dependency in locked-down environments. Revisit marketplace later. |
| 4 | Streaming responses | **Yes — stream progress in v1.** | Better UX for slow multi-source queries; report artifacts remain batch outputs. |
| 5 | Multi-user support | **One instance per user.** | Avoids shared-state auth/audit complexity in v1; per-user config already exists (CP-01). |
| 6 | Write-back to internal systems | **Defer implementation; design the approval-gate architecture now.** | Keep v1 read-and-report (PRD non-goal) but shape the Orchestrator/MCP allowlist so a write path can be added behind an approval gate without rework. |
| 7 | MCP server versioning | **Pin exact versions in `mcp-servers.json`; updates are config changes reviewed in VCS.** | Fits the admin-controlled, read-only-at-runtime registry (MCP-06) and locked-down deployments. |
| 8 | Long-running tasks | **Session-scoped only in v1.** | Re-runnable report templates (RG-08, Phase 2) cover the recurring case; no persistence/resumption in v1. |
| 9 | MCP server authoring | **Include scaffolding tools.** | Lets platform teams wrap internal services as MCP servers; ships alongside the config schemas, not in the model's runtime path. |

## Consequences

- Phase 1 build order: config schemas → Sandbox Enforcer (Docker + Firejail) → MCP Client Manager → File Manager → Orchestrator (streaming progress + write-gate design) → Claude Code / Codex plugin (manual install) → MCP server scaffolding tools.
- `mcp-servers.json` must carry an explicit `version`/pin field per server (Q7).
- Progress streaming is a P1 UX requirement for the plugin interface (Q4).
- The write-approval gate is a design-time deliverable for v1, not a runtime feature (Q6).
