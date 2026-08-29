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
node bin/sandy.js run <template> --config config/sandy.json       # re-run a saved request (templates.json)
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
Host tools exposed: `sandy.gather`, `sandy.report`, `sandy.status`, `sandy.model.usage`, `sandy.write` (+ `sandy.write.approve` / `sandy.write.revoke` for the consent flow), and `sandy.files.read|list|write|delete|mkdir|rename`.

**Conformance (the egress + runtime-agnostic guarantees):**
```bash
npm run conformance          # in-process + Docker egress + Docker/Firejail sandbox matrix
npm run test:conformance     # in-process only (no Docker needed)
npm run conformance:docker   # Docker network-level egress proof
npm run conformance:sandbox  # Docker + Firejail sandbox matrix (identical-behavior proof)
```

## Documentation

**Evaluating or adopting Sandy? Start with the [User Guide](guide/README.md)** — quickstart, architecture, configuration, CLI, plugin, standalone, security model, reports, and troubleshooting. A [product post](blog/sandy.md) gives the plain-English pitch.

| Document | Description |
|----------|-------------|
| [User Guide](guide/README.md) | Consumer-facing: quickstart, architecture, configuration, CLI, plugin, standalone, security, reports, troubleshooting |
| [Product Post](blog/sandy.md) | "The AI assistant that can't leave the sandbox" — the pitch, in plain English |
| [PRD Final](docs/PRD_Final.md) | Merged, authoritative product requirements document |
| [PRD Original](docs/PRD.md) | Initial product requirements document |
| [PRD Claude](docs/PRD_Claude.md) | Claude-contributed product requirements |
| [Phase 2 Design](docs/PHASE2_DESIGN.md) | Standalone service + bundled LLM (SD-01..06) — architecture, model backend, local API, decisions |
| [Model Provisioning](docs/MODEL.md) | How to install `llama-server` + the default model, the documented default model, and the resource-limit decision |
| [Decisions](docs/DECISIONS.md) | Resolved open PRD questions + settled design decisions (incl. the narrate threat model and the accepted DNS-rebinding limitation) |
| [Next Steps](docs/NEXT_STEPS.md) | Forward-looking resume point: current status, what's built (do not rebuild), the deferred roadmap |
| [Work Diary](docs/DIARY.md) | Append-only chronological log of every work block — the single narrative history |

## Status

**v0.1.3 — Phase 1 and Phase 2 are complete, and the real bundled model is proven end-to-end.** All 323 tests pass; typecheck + build green. Reports render as Markdown (source of truth), HTML, **DOCX, XLSX, or PDF** (`preferences.default_report_format`), with every claim traceable to its source call — each format is a deterministic view over the same provenance-tracked claims, and the binary formats are written as byte-exact artifacts through the sandboxed File Manager. Saved report templates (`templates.json`, issue #15) re-run a named request via `sandy run <template>` or `POST /run {"template"}` — validated by the same schema + legal tool catalog as any ad-hoc request. Write-back (Q6, issue #16) is available behind an approval gate: an admin `write_allowlist` (always a subset of the read allowlist, optionally constrained per-arg) + a single-use, per-write, audited, time-bound approval via the `sandy.write` tool (+ `sandy.write.approve` / `sandy.write.revoke` for the consent flow) — the default is still read-only (every write refused). The bundled model's hard memory ceiling defaults to the service manager's cgroup; `sandbox.enforce_memory_limit: true` (issue #18) additionally enforces it in-service via a cgroup, failing closed where there is no cgroup delegation. The standalone `ask` loop can now plan **multiple** gather rounds (issue #19, opt-in via `preferences.max_planning_rounds`, default 1): after each pass the model re-plans from the results, and every follow-up round is re-validated by the same schema + legal-tool-catalog gate as the first — bounded, audited, and consolidated into a single provenance-tracked report.

- **Both modes built and conformance-proven.** Plugin mode (host LLM reasons, Sandy executes as eleven `sandy.*` MCP tools) and standalone mode (bundled llama.cpp model, autonomous plan→run→narrate loop, loopback-only `sandy serve` REST API) are complete. The launch success criterion — zero network egress outside declared MCP endpoints — is proven in-process and at the network level in Docker, and the enforcer is proven runtime-agnostic: the same config + request under Docker and Firejail produce byte-identical behavior for **both** modes (CI matrix).
- **A real bundled model ran the full loop in a no-egress sandbox.** Qwen3-4B-Instruct-2507 (Vulkan/GPU, SHA256-pinned) planned (validated against the policy's legal tool catalog), the MCP tool ran, a provenance-tracked report was written, the model narrated (clearly labeled), usage was audited, and the model process was reaped. Provisioning is out-of-band (`scripts/provision-model.sh`); the runtime never downloads a model.
- **Reviewed and hardened.** The 2026-08-22 full-repo review is closed: 7 security findings fixed and released in v0.1.1 (7 private advisories), plus 12 follow-up fix PRs merged.

Where to look next:

- **What's built, module by module** — `docs/NEXT_STEPS.md` ("What's built" table)
- **What's next** (deferred product scope + optional hardening, each a tracked issue) — `docs/NEXT_STEPS.md`
- **How it got here** (chronological work log) — `docs/DIARY.md`
- **Settled decisions** — `docs/DECISIONS.md`; design: `docs/PHASE2_DESIGN.md`; model: `docs/MODEL.md`

## License

[Apache License 2.0](LICENSE) — see the `LICENSE` file.

Sandy is distributed under Apache-2.0. The bundled default model
(Qwen3-4B-Instruct) is itself [Apache-2.0](docs/MODEL.md), and the
`llama.cpp` runtime it runs on is MIT-licensed — both compatible with this
license. See `docs/MODEL.md` for the model's exact license and provenance.
