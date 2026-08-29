# Troubleshooting

How to diagnose a problem, read the signals, and fix the common failures. The two most useful tools are `sandy check` (the capability/health report) and the **exit code** (a stable contract — see below).

## Exit codes (the first thing to read)

| Code | Meaning | What to do |
|------|---------|------------|
| `0` | OK. A *degraded* state is **reported, not fatal** — read the `check` output for the `−` loss lines. | Nothing; the run is valid, just reduced. |
| `1` | Unexpected error. | Read the stderr message; file a bug if it's a Sandy defect. |
| `2` | Usage error — unknown verb/flag, invalid request file, unknown template name. | Fix the command. A `run` name that is neither a file nor a registered template is a usage error, never a silent guess. |
| `3` | **Config error** (fail-closed). | Fix `sandy.json` / `mcp-servers.json` — see [Common failures](#common-failures). |
| `4` | **Sandbox violation** — unsandboxed, or a declared/detected runtime mismatch. | Run inside the declared boundary; see below. |

A non-zero code from `check` is a *config/startup* problem, not a run failure — read the message.

## Start with `sandy check`

`check` does no work; it validates the config and prints the capability/health report. It is the single best diagnostic:

```bash
node bin/sandy.js check -c sandy.json --json   # machine-readable
```

Read it top to bottom:

- **`sandbox:`** the detected runtime vs. the declared one. A mismatch here is exit `4`.
- **`roots:`** the working roots. A root that doesn't exist inside the sandbox is a capability loss (`− root not accessible`).
- **`egress:`** the declared allowlist.
- **`capability:`** `full` or `reduced mode: N capability loss(es)`. Any `−` line tells you exactly what was lost (a missing root, an unresolvable stdio MCP command, …). Degraded is exit `0` — reported, not fatal.
- **MCP servers:** each `✓ connected` or its failure reason.
- **`RESULT: OK` / `DEGRADED`.**

## Common failures

### "Sandy requires a sandbox boundary; none detected" (exit 4)

You're running unsandboxed. That's a feature: Sandy refuses to start without a boundary. Run it inside Docker, Firejail, WSL, gVisor, etc. If you manage a custom boundary yourself, declare `sandbox.runtime: "custom"` (the one case where "no detector match" is permitted).

### "config declares sandbox runtime "X" but the detected runtime is "Y"" (exit 4)

The config was approved for one boundary and you're in another. Align them — either run in the declared boundary or change `sandbox.runtime`. (A `docker` declaration is accepted under a detected `k8s-pod`.)

### `ConfigError` at startup (exit 3)

The config is invalid. The message names the field. Typical causes:

- **Invalid JSON / schema violation** — a typo or a wrong-typed field.
- **A literal secret where an env-ref is expected** — use `"${VAR_NAME}"` and `export VAR_NAME=...` before running.
- **A `write_allowlist` entry wider than the read allowlist** — it names an unknown server or a tool outside that server's `allowed_tools`.
- **A `default_report_format` the renderer can't produce.**
- **An unimplemented combination** (e.g. `provider: remote` without `endpoint`).
- **A template registry entry** naming an unknown server or non-allowed tool.

### An MCP server won't connect

`check` shows the server's failure reason. Check:

- **stdio:** the `command` is resolvable inside the sandbox (a `− command not resolvable` loss in `check`). `npx`/`node` must be on the sandbox's `PATH`.
- **sse/http:** the URL is reachable *from inside the sandbox* and is in `sandbox.allowed_network` (a non-declared endpoint fails closed at startup, exit 3 — VPN-02).
- **auth:** `bearer`/`api_key` need a valid token (env-ref). `oauth` and `mtls` **fail closed** (not yet implemented) — an unauthenticated connect is refused.

### `egress blocked (…): <url> is not in the declared allowlist`

A network dial targeted an endpoint outside `sandbox.allowed_network`. Add the endpoint (and ensure the boundary actually permits it), or remove the call. This is the guard working as intended.

### A report is written with gaps instead of data

Gaps are **explicit holes, not errors** — the report correctly says what didn't contribute and why. Look at each gap's reason:

- `server-unavailable` — the server wasn't reachable (see MCP connect above).
- `call-failed` — the tool errored (the detail carries the cause, e.g. `500`).
- `empty-result` — the tool succeeded but returned nothing.

### Standalone: the model

- **`model_path` missing / engine fails closed at `start()`** — provision the model (`scripts/provision-model.sh`) or fix the absolute path.
- **Engine `degraded`** — the model process crashed or can't start (GPU driver for the Vulkan build, port conflict, OOM). Check `check`'s `engine` line and the model stderr; on a CPU-only box use the `ubuntu-x64` variant.
- **`enforce_memory_limit` fails closed** — no cgroup v2 delegation in this boundary (e.g. stock Docker). Delegate a cgroup or set it to `false` (the supervisor's cgroup ceiling then applies).
- **Plan rejected repeatedly** — the model's plans failed the schema + legal-catalog gate 3 times. The loop falls back to a deterministic plan (if the goal names one known tool) or refuses with an explicit gap. Tighten the goal or check the server's `allowed_tools`.

### `sandy serve`

- **Refused to bind** — an off-loopback host was requested. The service is loopback-only by design; bind `127.0.0.1` / `localhost`.
- **`415` on a POST** — the body wasn't `application/json`.
- **`403` on a request** — a foreign `Origin` header (cross-origin) was sent; legitimate local callers (curl, the CLI) send none.
- **`429` on a POST** — too many pending jobs; the bounded queue is full. Try again shortly.
- **`404` on `GET /jobs/:id`** — the job was evicted from the bounded completed retention (oldest first). This is a clean 404, not a crash.

## The audit log

For "what actually happened" — especially around write attempts, file mutations, and egress denials — read the audit log (`-o, --audit <path>`, JSONL, one event per line). It records every operation by type (see [Security model → The audit log](security.md#the-audit-log)): MCP calls by args-hash, file mutations + undos, write attempts + the gate's decision, model invocations, and `egress_blocked` entries for refused dials. In a service, `GET /audit` returns the transcript.

## When to report a bug

If an **unexpected** (exit `1`) error is not a config, sandbox, or usage issue, it's a Sandy defect. Include: the `sandy check --json` output, the exit code, the stderr message, and the audit log (`-o` path) — those four pin down almost everything.
