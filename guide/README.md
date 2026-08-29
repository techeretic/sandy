# Sandy User Guide

A consumer-facing guide to **Sandy** — a sandboxable AI assistant that gathers data from your internal services over MCP, writes provenance-tracked reports, and manages files, all confined to your sandbox with zero network egress outside the endpoints you declare.

If you're evaluating or adopting Sandy, start here.

## What you can do with Sandy

- **Gather** information from internal services (CRM, Jira, wikis, databases, observability) through MCP servers you explicitly declare.
- **Report** on it with full provenance — every claim footnoted to the exact source call (server, tool, args hash, timestamp), in **Markdown, HTML, DOCX, XLSX, or PDF**.
- **Manage files** inside the sandbox — create, edit, delete, rename — with confirmation gates, undo, and dry-run.
- **Write back** to internal systems, only behind an explicit, per-write, time-bound, audited approval.
- **Run anywhere** — inside Docker, Firejail, WSL, gVisor, or your own boundary — and **never escape it**.

## The two ways to use Sandy

| Mode | Who reasons | Best for | Entry point |
|------|-------------|----------|-------------|
| **Plugin** | The host LLM (Claude Code / Codex) | People already in a coding/assistant host who want sandboxed, audited execution | `plugin/` |
| **Standalone** | A small local model (bundled, air-gapped) | Fully local, VPN-restricted, or air-gapped environments | `sandy ask` / `sandy serve` |

Both share the same core: the same sandbox enforcer, the same MCP manager, the same File Manager, the same Orchestrator, and the same audit log. The only difference is who plans the work.

## How to read this guide

| Document | Read it when… |
|----------|---------------|
| [Quickstart](quickstart.md) | You want a first successful run in a few minutes |
| [Architecture](architecture.md) | You want the mental model: what runs where, what the security boundary is |
| [Configuration](configuration.md) | You're writing or reviewing `sandy.json` / `mcp-servers.json` |
| [CLI reference](cli.md) | You drive Sandy from the terminal (`check` / `run` / `ask` / `serve`) |
| [Plugin guide](plugin.md) | You integrate Sandy into Claude Code / Codex via the `sandy.*` MCP tools |
| [Standalone mode](standalone.md) | You run the bundled local model and the loopback `sandy serve` REST API |
| [Security model](security.md) | You're the operator, security, or compliance owner who needs to prove the guarantees |
| [Reports](reports.md) | You produce the outputs: formats, provenance, and recurring templates |
| [Troubleshooting](troubleshooting.md) | Something isn't working and you need to diagnose it |
| [Development](development.md) | You're contributing or building on top of the codebase |

Internal engineering docs (the PRD, the Phase 2 design, the decisions log, the work diary) live in [`docs/`](../docs/) — they explain *why* and *how it got here*. This guide explains *how to use it*.
