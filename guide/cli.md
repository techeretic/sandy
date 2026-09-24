# CLI Reference

Sandy is driven from the terminal. All result output goes to **stdout** (clean for piping); progress and errors go to **stderr**, so `--json` output is pipe-safe.

```bash
node bin/sandy.js <verb> [options]
# or, after `npm link`:
sandy <verb> [options]
```

## Verbs

| Verb | What it does |
|------|--------------|
| `check` | Validate the config and print a capability/health report. Does no work. |
| `run <request.json\|template>` | Run a request file **or** a saved template. |
| `ask "<goal>"` | (Standalone) Ask the bundled model to plan, run, report, and narrate. |
| `serve` | (Standalone) Run the long-lived, loopback-only REST + SSE service. |
| `import <url\|file\|->` | Validate + stage an MCP server manifest. **Staged by default** — nothing touches live config until you review and `--apply`. |

`run` target resolution (fail-closed): a path that **exists as a file** is always the request file. Otherwise the name is tried against the configured template registry — and only an exact match runs as a template. An unknown name that is neither a file nor a template is a **usage error**, never a silent guess.

## Options

| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Path to `sandy.json`. Default: `$SANDY_CONFIG`, then `./sandy.json`. |
| `-o, --audit <path>` | Write the append-only JSONL audit log to `<path>`. Default: in-memory only. |
| `--port <n>` | (serve) Loopback port. `0` = pick a free one (default). |
| `--json` | Print machine-readable JSON on stdout. |
| `--no-progress` | Disable streaming progress on stderr. |
| `--yes` | (import) Skip the one-shot fetch confirmation prompt. |
| `--apply` | (import) Promote the staged entry into live config. Default is **staged only**. |
| `--tools <s=a,b\[,;s2=c,d]>` | (import) Set a server's `allowed_tools`; each tool must be in that server's `capabilities`. Repeatable. |
| `-h, --help` | Show help. |
| `-V, --version` | Show the version. |

`import` (docs: [IMPORT_DESIGN](../docs/IMPORT_DESIGN.md)) takes a **URL**, a **file**, or `-` (stdin). It fetches (a one-shot, human-confirmed, audited egress dial — the only permitted exception to the zero-egress invariant), validates the content against the **same** fail-closed manifest schema as `mcp-servers.json`, and writes a **content-hash-pinned** staged entry under `.sandy-import/`. It then prints a review package: the entry, the exact `sandbox.allowed_network` lines to add, the env-var names to export (never values), and the per-server allowlist. The read allowlist is **never auto-expanded** — it stays exactly what the manifest declared unless you pass `--tools`. Only `--apply` (or editing the config yourself) promotes a staged entry; `--apply` re-runs the full config load as the final gate and refuses to overwrite existing server names. v1 is **deterministic-only**: the source must be a machine-readable manifest. Transcribing prose pages (`--auto`) is a documented follow-up — the core carries no LLM client in v1.

## Exit codes (stable contract for CI/callers)

| Code | Meaning |
|------|---------|
| `0` | OK. A *degraded* state is **reported**, not fatal. |
| `1` | Unexpected error — or a `run`/`ask` that gathered data but could not write its report (the claims/gaps are still printed, with `report: NOT WRITTEN — <reason>`). |
| `2` | Usage error (unknown verb/flag, invalid request file, unknown template, a `report.file` whose extension the configured `default_report_format` can't be written under — refused before any MCP call, invalid import source, cancelled import fetch). |
| `3` | Config error (fail-closed: invalid config, missing env, egress cross-check). |
| `4` | Sandbox violation (unsandboxed, or declared/detected runtime mismatch). |

## Examples

### Check

```bash
node bin/sandy.js check -c sandy.json
node bin/sandy.js check -c sandy.json --json            # machine-readable
```

### Run a request file

```bash
node bin/sandy.js run ./report.json -c sandy.json --audit /tmp/audit.jsonl
node bin/sandy.js run ./report.json --json | jq .claims  # pipe the result
```

### Run a saved template

```bash
node bin/sandy.js run deals-emea -c sandy.json          # name from templates.json
```

### Ask (standalone)

```bash
node bin/sandy.js ask "Summarize the EMEA deals" -c sandy.json
node bin/sandy.js ask "What's at risk this sprint?" --json
```

### Serve (standalone)

```bash
node bin/sandy.js serve -c sandy.json --port 0          # picks a free loopback port
# → sandy: serving on http://127.0.0.1:53211 (loopback-only)
```

See [Standalone mode → REST API](standalone.md#the-rest-api) for the endpoints.

### Import an MCP server (stage, review, apply)

```bash
# Stage from a URL (one-shot confirmed fetch) — nothing touches live config:
node bin/sandy.js import https://registry.internal/servers/jira.json
# → staged: .sandy-import/<sha256>.json  (review the printed package)

# Same, from a file or stdin (air-gap: fetch elsewhere, import here):
node bin/sandy.js import ./jira.json
curl -s https://registry.internal/servers/jira.json | node bin/sandy.js import -

# Tighten the read allowlist, then promote into live config:
node bin/sandy.js import https://registry.internal/servers/jira.json \
  --tools jira=read_sprints,read_issues --apply
# → appends the server to mcp-servers.json, adds sandbox.allowed_network
#   entries, and re-runs the full config load as the final gate.
```

Exit codes follow the stable contract: usage-class errors (bad source, cancelled
fetch) exit `2`; fail-closed validation/config errors exit `3`. The fetch and the
stage/apply decision are recorded in the audit log (`import_fetch`,
`import_staged`) when `-o, --audit <path>` is given.

## Reading the output

### `check`

```
Sandy check
  mode:        standalone
  sandbox:     docker (declared: docker)
  roots:       /home/user/sandy-workspace
  egress:      jira.internal:8443
  capability:  full (no capabilities lost)
  MCP servers:
    ✓ crm — connected
    ✓ jira — connected
  audit:       /tmp/audit.jsonl

  RESULT: OK
```

`DEGRADED` (still exit `0`) means the detected boundary denied something Sandy declared — the `capability` line and any `−` loss lines tell you exactly what.

### `run`

```
Sandy run
  goal:    Summarize the EMEA deals
  claims (2):
    1. 3 deals closed in EMEA  [task=deals, crm/read_deals]
    2. Pipeline value $1.2M  [task=deals, crm/read_deals]
  gaps (1):
    − contacts (crm/read_contacts): call failed — 500
  report:  reports/deals-emea.md
  audit:   /tmp/audit.jsonl
```

Claims are provenance-tagged (the source call is named); gaps are explicit holes, never filled with invented data. `--json` returns the structured `{ goal, claims, gaps, reportPath, reportContent|reportArtifactB64, transcript }`.

### `ask`

```
Sandy ask
  goal:    Summarize the EMEA deals
  plan:    model after 1 attempt(s)
  claims (1):
    1. {"region":"emea"}  [task=deals, crm/read_deals]
  gaps (0):
    (none)
  narrative (local model):
    Two deals closed in EMEA this quarter per the CRM.
  report:  reports/report-1724000000000.md
  audit:   /tmp/audit.jsonl
```

The `narrative` block is the **local model's** prose, clearly labeled as such. The claims remain the independently traceable source of truth. With `max_planning_rounds > 1`, a `rounds:` line reports how many gather passes ran and why the loop stopped.

## The audit log

`-o, --audit <path>` appends a structured JSONL log of **every** operation (MCP calls by args-hash, file mutations + undos, write attempts + decisions, model invocations, the session lifecycle). It is the forensic record a compliance owner needs — see [Security model → Audit](security.md#the-audit-log).
