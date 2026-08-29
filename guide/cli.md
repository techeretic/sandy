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

`run` target resolution (fail-closed): a path that **exists as a file** is always the request file. Otherwise the name is tried against the configured template registry — and only an exact match runs as a template. An unknown name that is neither a file nor a template is a **usage error**, never a silent guess.

## Options

| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Path to `sandy.json`. Default: `$SANDY_CONFIG`, then `./sandy.json`. |
| `-o, --audit <path>` | Write the append-only JSONL audit log to `<path>`. Default: in-memory only. |
| `--port <n>` | (serve) Loopback port. `0` = pick a free one (default). |
| `--json` | Print machine-readable JSON on stdout. |
| `--no-progress` | Disable streaming progress on stderr. |
| `-h, --help` | Show help. |
| `-V, --version` | Show the version. |

## Exit codes (stable contract for CI/callers)

| Code | Meaning |
|------|---------|
| `0` | OK. A *degraded* state is **reported**, not fatal. |
| `1` | Unexpected error. |
| `2` | Usage error (unknown verb/flag, invalid request file, unknown template). |
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
