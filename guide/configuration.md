# Configuration

Sandy is configured by **two files**: `sandy.json` (the main config) and the MCP server manifest it points at (`mcp-servers.json`). Both are validated **fail-closed** at startup — an invalid config is a startup error (exit code `3`), never a silent guess. Secrets are **environment references only**, never literals.

A complete annotated example is in [`config/sandy.json`](../config/sandy.json) and [`config/mcp-servers.json`](../config/mcp-servers.json).

## `sandy.json`

### Top level

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | `"plugin"` \| `"standalone"` | yes | Who reasons. `plugin` = the host LLM (Claude Code / Codex). `standalone` = the bundled local model. |
| `llm` | object | yes | The reasoner's backend (below). |
| `sandbox` | object | yes | The security boundary declaration (below). |
| `mcp_servers` | string (path) | yes | Path to the MCP server manifest. |
| `report_output_dir` | string (path) | yes | Where reports are written (inside the working roots). |
| `policy` | object | yes | Confirmation, undo, and audit policy (below). |
| `preferences` | object | no | UX/report knobs (below). |
| `templates` | object | no | `{ "path": "./templates.json" }` — an optional registry of saved requests ([Reports](reports.md)). |
| `write_allowlist` | array | no | The admin write-back allowlist (below). Absent ⇒ write-back is unavailable (default read-only). |

### `llm`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `"host"` \| `"local"` \| `"remote"` | yes | `host` = the plugin host's LLM (no other fields needed). `local` = the bundled model (needs `model` + `model_path`). `remote` = a configured endpoint (needs `endpoint`). |
| `model` | string | for `local` | Logical model name. |
| `model_path` | absolute path | for `local` | Where the GGUF file lives (see [Standalone mode](standalone.md)). |
| `endpoint` | URL | for `remote` | The OpenAI-compatible endpoint. |
| `api_key` | `"${ENV_REF}"` \| null | no | Bearer credential for a remote endpoint. Env-ref only. |
| `engine` | object | no | Local model runtime options (see [Standalone mode](standalone.md)): `type` (`llama-server` default), `command`, `host` (loopback only, default `127.0.0.1`), `port` (`0` = pick a free one). |

### `sandbox`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runtime` | enum | yes | The boundary you're running in: `docker`, `firejail`, `wsl`, `gvisor`, `k8s-pod`, `systemd-nspawn`, `chroot`, `macos-sandbox-exec`, `windows-appcontainer`, or `custom`. |
| `allowed_paths` | absolute path[] | yes (≥1) | Your **working roots** — the only files Sandy may touch. Must be absolute, no `..`. |
| `allowed_network` | `host:port`[] | no (default `[]`) | The **only** network endpoints Sandy may reach. Default empty = no egress at all. |
| `max_memory_mb` | int > 0 | yes | Memory budget (bytes to the cgroup ceiling / in-service bound). |
| `max_cpu_percent` | int 1–100 | yes | CPU budget. Mapped to the local model's `--threads` (100 = no limit). |
| `enforce_memory_limit` | bool | no (default `false`) | Opt-in in-service hard memory bound on the bundled model (cgroup v2). Fails closed where there's no cgroup delegation. See [Standalone mode](standalone.md). |

### `policy`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `confirmation_required` | `delete`/`overwrite`/`rename`/`create`[] | `["delete","overwrite"]` | Which file ops require confirmation. **`delete` and `overwrite` are required** — the schema enforces "stricter, never looser." |
| `undo_depth` | int ≥ 0 | `0` | How many file mutations are undoable within a session. |
| `dry_run_default` | bool | `false` | Whether file ops default to plan-only. |
| `audit_payload_logging` | bool | `false` | Whether to log call payloads (args are logged by hash by default). |
| `ignore_patterns` | string[] | `[]` | Glob patterns excluded from file operations (e.g. `*.env`). |
| `approval_ttl_seconds` | int 1–86400 | `1800` | How long a write approval is valid (see [Security model → Write-back](security.md#write-back-q6)). |

### `preferences`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `default_report_format` | `markdown`/`html`/`docx`/`xlsx`/`pdf` | `markdown` | The report format for runs that don't specify one. All five are implemented ([Reports](reports.md)). |
| `max_concurrent_mcp_calls` | int 1–100 | `5` | Gather fan-out concurrency bound. |
| `stream_progress` | bool | `true` | Stream progress events. |
| `max_planning_rounds` | int 1–5 | `1` | Standalone only: how many gather passes the loop may run before consolidating. `1` = single pass. See [Standalone mode](standalone.md). |

### `write_allowlist` (write-back)

Optional. When present, write-back is enabled and governed by an admin allowlist. Each entry is a `(server, tool)` pair that a write may target:

```json
"write_allowlist": [
  { "server": "crm", "tool": "close_deal", "args": { "region": { "const": "emea" } } }
]
```

- It is always a **subset of the read allowlist** — an entry naming an unknown server or a tool outside the server's `allowed_tools` is a config error (fail-closed).
- `args` (optional) is a **per-arg constraint**: a JSON Schema fragment the write's args must satisfy (checked with the same semantics as the MCP SDK's `structuredContent`). Omit it to allow any args.
- Absent (or empty) ⇒ **no writes are possible** — the default gate refuses everything. See [Security model → Write-back](security.md#write-back-q6).

## `mcp-servers.json`

A manifest of the MCP servers Sandy may use. At least one server is required; names must be unique.

```json
{
  "servers": [
    {
      "name": "crm",
      "transport": "stdio",
      "command": ["npx", "-y", "@company/crm-mcp-server"],
      "env": { "CRM_API_KEY": "${CRM_API_KEY}" },
      "version": "1.4.2",
      "capabilities": ["read_deals", "read_contacts"],
      "allowed_tools": ["read_deals", "read_contacts"]
    },
    {
      "name": "jira",
      "transport": "sse",
      "url": "https://jira.internal:8443/mcp",
      "auth": { "type": "bearer", "token": "${JIRA_TOKEN}" },
      "version": "0.9.1",
      "capabilities": ["read_sprints", "read_issues"],
      "allowed_tools": ["read_sprints"]
    }
  ]
}
```

### Server fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | kebab-case string | Unique server identifier. |
| `transport` | `stdio` \| `sse` \| `http` | How Sandy connects. |
| `command` | string[] | **stdio** only: the executable + args to spawn. |
| `env` | map of `"${ENV_REF}"` | **stdio** only: environment for the server process. Env-refs only. |
| `url` | URL | **sse / http**: the endpoint. |
| `auth` | object | **sse / http**: `bearer`/`api_key` (need `token`), `oauth` (need `client_id` + `token_url`), or `mtls` (need the cert paths). `oauth` and `mtls` **fail closed** (not yet implemented) — unauthenticated connects are refused. |
| `version` | exact semver pin | **Required.** Updates are config changes reviewed in VCS (a VCS-reviewed registry). |
| `capabilities` | string[] | The server's full capability set (informational). |
| `allowed_tools` | string[] (≥1) | The **subset** of capabilities Sandy may actually call. Every entry must be in `capabilities`. This is the **read allowlist**. |

> The **read allowlist** (`allowed_tools`) is the ceiling for what any request — ad-hoc, templated, or model-planned — may call. The **write allowlist** (`write_allowlist`) is a stricter subset of it. Nothing is ever legal because a request is "saved" or "planned."

## Environment references

Secrets and secret-like values are **always** `"${VAR_NAME}"` (uppercase, env-resolved at point of use, never stored or logged). A literal value where an env-ref is expected is a config error. Export the variables in your environment before running:

```bash
export JIRA_TOKEN="..."
export CRM_API_KEY="..."
```

## Fail-closed behavior

Every part of config loading refuses rather than guesses:

- Invalid JSON or schema violation → `ConfigError` (exit `3`).
- An unimplemented combination (e.g. `provider: remote` without `endpoint`) → `ConfigError`.
- A write-allowlist entry wider than the read allowlist → `ConfigError`.
- A `default_report_format` the renderer can't produce → `ConfigError` (never a silent fallback to Markdown).
- A declared `allowed_network` endpoint that the detected boundary can't reach → reported as **reduced mode** (the capability manifest says what was lost), not a crash.
