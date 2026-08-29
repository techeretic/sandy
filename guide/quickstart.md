# Quickstart

Get a first successful run in a few minutes. You'll build Sandy, point it at a config, and run it **inside a sandbox** (Sandy refuses to start without a boundary — that's a feature, not a bug).

## Prerequisites

- **Node.js ≥ 22**
- A **sandbox** to run inside: Docker (easiest) or Firejail. You can also use WSL, gVisor, systemd-nspawn, or a custom boundary.
- At least one **MCP server** you want to reach (for the read-and-report demo below, any will do).

> **Why a sandbox?** Sandy's entire security model is "I only do what this boundary allows." At startup it detects the boundary, computes its effective capability manifest, and **fails closed** if it can't prove it's confined. Running it unsandboxed is exactly what it's built to prevent, so it will exit with code `4`.

## 1. Get the code

```bash
git clone <your-sandy-repo-url> sandy
cd sandy
npm ci          # install dependencies
npm run build   # compile to dist/
```

The CLI entry point is `node bin/sandy.js` (or `node dist/cli.js`). `sandy` is also declared as the package `bin`, so `npm link` gives you a global `sandy` command if you like.

## 2. Write a config

Create `sandy.json` (a template is in [`config/sandy.json`](../config/sandy.json)):

```json
{
  "mode": "plugin",
  "llm": { "provider": "host" },
  "sandbox": {
    "runtime": "docker",
    "allowed_paths": ["/home/user/sandy-workspace"],
    "allowed_network": ["jira.internal:8443"],
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
    "ignore_patterns": ["node_modules/", ".git/", "*.env"]
  },
  "preferences": { "default_report_format": "markdown" }
}
```

And `mcp-servers.json` (a template is in [`config/mcp-servers.json`](../config/mcp-servers.json)):

```json
{
  "servers": [
    {
      "name": "jira",
      "transport": "sse",
      "url": "https://jira.internal:8443/mcp",
      "auth": { "type": "bearer", "token": "${JIRA_TOKEN}" },
      "version": "0.9.1",
      "capabilities": ["read_sprints", "read_issues"],
      "allowed_tools": ["read_sprints", "read_issues"]
    }
  ]
}
```

Notes:
- `allowed_paths` are your **working roots** — the only files Sandy may touch. Use absolute paths.
- `allowed_network` are the **only** network endpoints Sandy may reach. Everything else is blocked.
- Secrets are **environment references** only (`"${JIRA_TOKEN}"`), never literals. Export the variable before you run.

## 3. Check

Before doing any work, validate the config and see Sandy's capability/health report:

```bash
export JIRA_TOKEN="..."
node bin/sandy.js check -c sandy.json --audit /tmp/sandy-audit.jsonl
```

You should see the detected sandbox runtime, the allowed roots, the egress allowlist, each MCP server's connection state, and a final `RESULT: OK` (or `DEGRADED` — which is reported, not fatal). A non-zero exit code here is a config problem, not a run failure — read the message.

## 4. Run a report

A request is a JSON file: a `goal`, the `gather` tasks (server + tool + args), and an optional `report` spec.

```bash
cat > report.json <<'EOF'
{
  "goal": "Summarize the current sprint in Jira",
  "gather": [
    { "id": "sprints", "server": "jira", "tool": "read_sprints", "args": {} }
  ],
  "report": { "title": "Sprint Health", "file": "sprint-health.md" }
}
EOF

node bin/sandy.js run report.json -c sandy.json --audit /tmp/sandy-audit.jsonl
```

Sandy fans out the gather tasks (bounded concurrency), turns each successful call into a **provenance-tracked claim**, records every failure as an explicit **gap** (never invented filler), and writes `reports/sprint-health.md` — where every statement is footnoted to its source call.

Run it from a **template** instead of a file:

```bash
# with "templates": { "path": "./templates.json" } in sandy.json
node bin/sandy.js run sprint-health -c sandy.json   # name resolves against the registry
```

## 5. Or run standalone (bundled local model)

To run fully local with no host LLM:

```bash
bash scripts/provision-model.sh          # installs llama-server + the pinned default model (out-of-band)
# set "mode": "standalone" and the "llm" block in sandy.json (the script prints it)

node bin/sandy.js ask "Summarize the EMEA deals" -c sandy.json   # model plans → gathers → reports → narrates
node bin/sandy.js serve -c sandy.json                            # long-lived loopback-only REST + SSE service
```

The model runs **inside the sandbox on loopback** — zero egress by construction. See [Standalone mode](standalone.md).

## You're running Sandy

From here, pick your path:

- Drive it by hand → [CLI reference](cli.md)
- Plug it into Claude Code / Codex → [Plugin guide](plugin.md)
- Run the local model + service → [Standalone mode](standalone.md)
- Understand the guarantees you just relied on → [Security model](security.md)
