# Plugin Guide (Claude Code / Codex)

In plugin mode the **host LLM is the reasoner** — Claude Code or GitHub Codex. You install the Sandy plugin, which registers `sandy` as a **stdio MCP server** exposing a small set of sandboxed capabilities. The host LLM does the reasoning and calls the `sandy.*` tools; Sandy executes them deterministically inside the sandbox and returns structured results.

This is the "the host LLM plans, Sandy does the sandboxed work" split: the model never touches the network or filesystem directly — it can only go through Sandy, and only what the policy allows.

## Install

Manual install (git repo + copy, no registry dependency — deliberate for locked-down environments):

```bash
git clone <your-sandy-repo-url> sandy && cd sandy
npm ci && npm run build
./plugin/install.sh --dir ~/.claude/plugins        # Claude Code (default)
# or, for a Codex config dir:
./plugin/install.sh --host codex --dir <your-codex-plugin-dir>
```

The installer copies the plugin manifest + the built `dist/` into your host's plugin directory. The manifest (`plugin/.claude-plugin/plugin.json`) declares `sandy` as a stdio MCP server that runs `node dist/plugin/mcp-server.js` and reads `sandy.json` from the working directory (or `$SANDY_CONFIG`).

Then, **inside your sandbox**, make sure `sandy.json` (and its manifest) are reachable from the working directory and the MCP servers it declares are reachable. Run `sandy check` from the same sandbox to confirm before relying on the plugin.

> The host (Claude Code / Codex) runs wherever it runs; the **Sandy MCP server process** is what must be inside the sandbox. Sandy refuses to start without a boundary, so the plugin will report a sandbox violation (exit `4`) if it's started unsandboxed.

## The tools

All tools are namespaced `sandy.*`. Every tool body is validated against a strict schema; a malformed body returns a structured error, not a crash. File and write tools that need user confirmation return `needsConfirmation` / `needsApproval` rather than acting — **Sandy never decides for itself** (FM-04 / Q6).

### Read-and-report

| Tool | Purpose |
|------|---------|
| `sandy.gather` | Fan out gather tasks; return provenance-tracked **claims** + explicit **gaps** + progress. No report file. |
| `sandy.report` | Gather and produce a report written inside the sandbox. Returns the report path, content (or `reportArtifactB64` for binary formats), claims, and gaps. |

`gather` and `report` take a `goal` and `gather` (an array of `{ id, server, tool, args }` tasks; `report` adds an optional `{ title, file, summary }`). Only `server`/`tool` pairs in the policy's legal catalog are legal — the host can only plan what the policy already allows.

`summary` is an optional **host-LLM narrative** for the report. It is clearly labeled in the output as model prose; the claims remain the independently traceable source of truth.

### Status + model usage

| Tool | Purpose |
|------|---------|
| `sandy.status` | The capability/health report (same shape as `sandy check --json`): sandbox runtime + reduced-mode capability, MCP connectivity, engine health, write posture. |
| `sandy.model.usage` | The **host LLM reports its own token usage** so it lands in Sandy's audit log (AU-01). The host is the engine in plugin mode; it knows its token counts, Sandy records them. Returns the audit `seq` as a receipt. |

### File management

| Tool | Purpose |
|------|---------|
| `sandy.files.read` | Read a text file inside the working root. |
| `sandy.files.list` | List a directory (optionally recursive). |
| `sandy.files.write` | Create/overwrite a file. Confirmation-gated ops return `needsConfirmation`. |
| `sandy.files.delete` | Delete a file or directory. Confirmation-gated. |
| `sandy.files.mkdir` | Create a directory. Confirmation-gated by policy. |
| `sandy.files.rename` | Rename/move. Confirmation-gated (a rename-onto-existing also requires the overwrite confirmation). |

Mutating file tools return `{ applied, path, dryRun, needsConfirmation?, error? }`. When `needsConfirmation` is set, surface the prompt to the user and re-invoke with `confirmed: true`. `dryRun: true` plans without touching the filesystem.

### Write-back (approval-gated, Q6)

| Tool | Purpose |
|------|---------|
| `sandy.write` | Write back to an internal system via an MCP tool. **Approval-gated**: each task must be on the admin `write_allowlist` **and** carry an explicit per-write approval. Tasks without a valid approval are refused, never auto-approved. |
| `sandy.write.approve` | Record a per-write approval ahead of time (the user's consent). Returns the computed `expiresAt`. Single-use and time-bound. |
| `sandy.write.revoke` | Withdraw a pending approval before it's used (task-scoped, optionally approver-scoped). A revoked pair can never approve again. |

**The consent flow.** If `sandy.write` is called for legal-but-unapproved tasks, the result's `needsApproval` lists exactly those tasks (with their `approvalTtlSeconds`) so the host can put them to the user. A *policy* refusal (not allowlisted / args out of bounds / read-only gate) is deliberately **not** listed — asking the user could not make it legal. The host then either re-invokes `sandy.write` with inline `approvals`, or records consent via `sandy.write.approve` first.

Write-back is **off by default**: with no `write_allowlist` in config, the default gate refuses every write. See [Security model → Write-back](security.md#write-back-q6).

## A worked example

User (to the host LLM): *"Summarize the EMEA deals and save it."*

1. Host LLM calls `sandy.report` with `{ goal: "Summarize EMEA deals", gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }], report: { title: "EMEA Deals" } }`.
2. Sandy validates the request against the schema + legal catalog, runs it, and returns the claims, gaps, `reportPath`, and `reportContent`.
3. Host LLM (optionally) calls `sandy.model.usage` to log its own token counts.
4. The user gets a provenance-tracked `EMEA Deals` report inside the sandbox, and the audit trail records the whole thing.

## Error handling

Every tool returns a **structured** result. Failures are data (`{ error: { reason, detail } }`, `isError: true`) rather than thrown exceptions, because an LLM reads the result — a thrown error would be lost. Confirmation gates surface as `needsConfirmation` / `needsApproval` so the host can complete the human-in-the-loop step.
