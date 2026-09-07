# Config

Sandy is configured by a small set of JSON files. Everything is validated
**fail-closed** at startup — an invalid config is a startup error (exit code `3`),
never a silent guess. The full reference lives in
[the User Guide → Configuration](../guide/configuration.md); this page covers the
files shipped here and how to get from a fresh checkout to a working setup.

## The files

| File | Loaded by Sandy? | What it is |
|------|------------------|------------|
| `sandy.json` | **yes** | The main config: mode, LLM, sandbox, policy, preferences. Points at the other files. |
| `mcp-servers.json` | **yes** | The MCP server manifest. **Starts empty** — add the servers you actually use. |
| `templates.json` | **yes** | Named saved requests. **Starts empty** (`{}`). |
| `mcp-servers.example.json` | no — reference only | Annotated example of a couple of servers (a stdio + an SSE one). Copy what you need into `mcp-servers.json`. |
| `templates.example.json` | no — reference only | Two example templates. Copy what you need into `templates.json`. |

A fresh checkout runs **clean with zero MCP servers**: `node bin/sandy.js check
--config config/sandy.json` validates the config and reports `OK` with no servers,
rather than demanding credentials you don't have yet. The `.example.json` files are
documentation — Sandy never reads them, so their `${…}` secret refs are inert.

## Adding an MCP server

1. Copy a server entry from `mcp-servers.example.json` into `mcp-servers.json`
   (or write your own to match the schema).
2. **Secrets are environment references only** — `"${VAR_NAME}"`, never a literal.
   Set the env var before running (e.g. `export CRM_API_KEY=…`); Sandy resolves it
   at the point of use and never stores or logs the value.
3. For a **remote** server (transport `sse`/`http`), add its endpoint to
   `sandy.json → sandbox.allowed_network` — egress is restricted to the endpoints
   you declare (VPN-02), and the loader cross-checks this and refuses to start if
   a server targets an undeclared endpoint.
4. `allowed_tools` must be a subset of the server's `capabilities`, and each server
   needs an exact semver `version` pin.

`templates.json` entries target a server + tool that must already be declared in
`mcp-servers.json` and allowed there; a mismatch is a config error.

## Verifying

```bash
node bin/sandy.js check --config config/sandy.json
```

`check` validates the config and prints a capability/health report. With no servers
it reports `OK` and tells you to add some; once servers are declared it shows each
as connected / degraded / failed and any missing secret as a config error.
