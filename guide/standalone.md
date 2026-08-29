# Standalone Mode (bundled local model)

Standalone mode is Sandy with **no host LLM and no internet**: a small local model does the reasoning, running **as a subprocess on loopback inside the same sandbox** you run Sandy in. Because the model's only network path is loopback to its own process, the whole system has **zero external egress by construction** — the only outbound traffic is the declared MCP endpoints, through the same enforcer as plugin mode.

This is the mode for **fully local, VPN-restricted, or air-gapped** environments where no frontier model can reach your internal data.

```
   your goal
      │
      ▼
┌──────────────────────────────────────────────────────┐
│  The sandbox (Docker / Firejail / …)                 │
│                                                      │
│   ┌────────────────────────────┐    ┌─────────────┐  │
│   │  sandy (the executor)      │    │  local model │  │
│   │  parse → run → narrate     │◀──▶│  (llama-     │  │
│   │  (deterministic, audited)  │    │   server)    │  │
│   └─────────────┬──────────────┘    └─────────────┘  │
│                 │  declared MCP endpoints only        │
└─────────────────┼─────────────────────────────────────┘
                  ▼
              internal services
```

The same core as plugin mode — the same Sandbox Enforcer, MCP Manager, File Manager, Orchestrator, and audit log. The only difference: who plans. Here, a 4B-class instruct model plans; Sandy still validates, confines, runs, and audits every step.

## Provisioning the model + runtime

The runtime **never downloads a model.** Provisioning is an install-time, out-of-band step:

```bash
npm ci && npm run build
bash scripts/provision-model.sh
```

The helper:

- installs **`llama-server`** (the `llama.cpp` runtime; **Vulkan** build by default — GPU acceleration with no CUDA toolkit),
- downloads the **default model**: **Qwen3-4B-Instruct-2507, Q4_K_M GGUF** (~2.4 GB, **Apache-2.0**),
- verifies **both by SHA256 and fails closed on a mismatch** (a tampered/truncated asset is removed and never used — including the runtime binary, which is verified *before* extraction),
- prints the ready-to-paste `llm` block for `sandy.json`.

**Air-gapped host:** run the helper on an internet-connected machine, then copy the model file + the `llama.cpp` directory over and point `llm.model_path` / `llm.engine.command` at the new absolute paths. Nothing in the runtime is network-dependent at that point. See [`docs/MODEL.md`](../docs/MODEL.md) for the exact pins, the CPU-only variant (`SANDY_LLM_VARIANT=ubuntu-x64`), and how to pin a different release.

## The `llm` block

After provisioning, set `mode: "standalone"` and point `llm` at the model (the script prints it; the fields below are the full reference):

```json
{
  "mode": "standalone",
  "llm": {
    "provider": "local",
    "model": "qwen3-4b-instruct-2507",
    "model_path": "/home/user/.local/share/sandy/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    "engine": {
      "type": "llama-server",
      "command": ["/home/user/.local/share/sandy/llama.cpp/llama-server"],
      "host": "127.0.0.1",
      "port": 0
    }
  }
}
```

| Field | Notes |
|-------|-------|
| `provider` | `"local"` for the bundled model. (`"remote"` points at an egress-guarded OpenAI-compatible endpoint instead — see below.) |
| `model` | Logical name; cosmetic to the runtime. The actual file is `model_path`, so swapping models is a **config change, not a code change**. |
| `model_path` | Absolute path to the GGUF. The engine **fails closed** at `start()` if the file is missing. |
| `engine.type` | `llama-server` (default). |
| `engine.command` | The `llama-server` executable. |
| `engine.host` | **Loopback only** (default `127.0.0.1`). Off-loopback is refused — the model is a local subprocess, never a network service. |
| `engine.port` | `0` = pick a free port (default). The engine discovers the bound port from the server's startup log, so this is only for a fixed-port deployment. |

### Resource limits for the model

The declared sandbox caps map to real levers on the model process:

- **CPU:** `sandbox.max_cpu_percent` → a llama.cpp `--threads` budget. `100` means "no effective limit" (the flag is not passed); any lower value *reduces* the thread budget (tighten-never-loosen).
- **Memory (default ceiling):** the **service manager's cgroup** (`memory.max` / Docker `--memory` / systemd `MemoryMax=`). Sandy sets the soft knobs; the supervisor enforces the hard ceiling.
- **Memory (opt-in in-service bound):** `sandbox.enforce_memory_limit: true` makes Sandy enforce the ceiling itself — the model's process group is wrapped in a cgroup v2 child whose `memory.max` is `sandbox.max_memory_mb`. This **requires cgroup v2 delegation** (a systemd scope/unit with `Delegate=yes`); in a boundary without it (e.g. a stock Docker container with a read-only cgroup fs) the engine **fails closed (degraded)** rather than run a model the operator asked to cap without the cap. Default off.

## `sandy ask` — the autonomous loop

```bash
node bin/sandy.js ask "Summarize the EMEA deals" -c sandy.json
```

The loop: **parse → run → narrate**, over the same deterministic orchestrator plugin mode uses.

1. **Parse.** The model proposes a plan (a structured JSON of gather tasks). The plan is validated against the **request schema AND the legal tool catalog** — only `server`/`tool` pairs the policy already allows are legal. "The model proposes, the schema disposes." A rejected plan feeds the error back for retry (up to 3 attempts); on exhaustion Sandy falls back to a **deterministic** conservative plan (a single task, if the goal names exactly one known tool), else it **refuses and reports an explicit gap**. It is never unbounded and never invents a request.
2. **Run.** The validated plan goes through the unchanged Orchestrator — bounded fan-out, provenance claims, explicit gaps.
3. **Narrate (optional).** The model writes a prose summary, **clearly labeled** as model narrative in the report. The claims remain the independently traceable source of truth; the narrative is a convenience, not a second source.

A **dead or erroring model degrades — it never crashes the loop** (the fallback / no-narrative path stands). Every model call is audited (`model_invocation`), and each step is audited too (`standalone_parse` / `standalone_plan` / `standalone_narrate`).

### Multi-round planning (opt-in)

By default the loop is a single gather→report pass (`preferences.max_planning_rounds: 1`). Setting it to `2`–`5` makes the model **re-plan from the results so far** after each pass:

- it can `stop` (the data suffices), or
- propose **additional** gather tasks that pass the **same** schema + legal-tool-catalog gate as round 1 — legality can never loosen in a later round.

A re-plan that only re-proposes a call already made (same server + tool + canonicalized args) is treated as "nothing new" and ends the loop — no re-gathering churn. On exhaustion (a dead model / no legal follow-up) the rounds gathered so far stand — reported, never a crash. All rounds consolidate into **one** re-rendered report (claim refs renumbered, provenance untouched), and the narrate covers the whole. Each re-plan is audited (`standalone_replan`) and streams `replan-*` progress events.

## `sandy serve` — the loopback-only service

For a long-lived service (a UI or other local tools calling Sandy), run the **loopback-only** REST + SSE API:

```bash
node bin/sandy.js serve -c sandy.json            # picks a free loopback port
node bin/sandy.js serve -c sandy.json --port 8080
# → sandy: serving on http://127.0.0.1:8080 (loopback-only)
```

The service:

- **binds `127.0.0.1` only** — binding off-loopback is **refused fail-closed**. It is per-user and must never become a network-exposed endpoint (this closes the ingress side; egress was already confined by the NetworkGuard).
- runs the model **eagerly** at startup, and **reaps it on shutdown** (no orphan process).
- has a **bounded job store** (max pending → `429`; completed retention with oldest-evicted → a clean `404`) so a long-lived process never grows without limit.
- runs jobs **serially** through one worker (progress is only unambiguous one job at a time).

### The REST API

All bodies are `application/json` (anything else → `415`); a foreign `Origin` header → `403` (CSRF-hardened, independent of CORS).

| Endpoint | Description |
|----------|-------------|
| `GET /health` | The capability/health report (same shape as `sandy check --json`). |
| `POST /run` | Enqueue a run. Body: a raw request **or** `{ "template": "<name>" }`. → `202 { id, status }`. |
| `POST /ask` | Enqueue an ask. Body: `{ "goal": "<non-empty string>" }`. → `202 { id, status }`. |
| `GET /jobs/:id` | Job status + result (claims, gaps, `reportPath`, `reportContent` / `reportArtifactB64`, `transcript`, and the `template` used when run from one). |
| `GET /jobs/:id/events` | **SSE** progress stream for the job (`running`, `progress`, `done` / `error`). Late subscribers replay the accumulated progress, so the stream is race-free. |
| `GET /reports` | List the reports written in the confined reports dir. |
| `GET /audit` | The session transcript export (the full audit record). |

A `POST /run` / `POST /ask` body is validated by the **same** `orchestratorRequestSchema` + legal tool catalog the CLI and plugin use — nothing is legal because it arrived over HTTP.

```bash
# a quick round trip
id=$(curl -s -X POST localhost:8080/run -H 'content-type: application/json' \
  -d '{ "template": "deals-emea" }' | jq -r .id)
curl -s localhost:8080/jobs/$id | jq .result.reportPath
curl -N localhost:8080/jobs/$id/events     # SSE progress
```

## Swapping the model

Because the model is addressed by `model_path`, swapping is a config change: point at a different GGUF (and, if needed, `engine.command`), and the rest of the system is unchanged. `provider: "remote"` is the alternative for an egress-guarded OpenAI-compatible endpoint (the endpoint must be in `sandbox.allowed_network`; the credential is an env-ref). The bundled local model remains the documented, air-gap-friendly default.

## Troubleshooting

- **`model_path` missing** → the engine fails closed at `start()`. Run `scripts/provision-model.sh` (or copy the GGUF over on an air-gapped host) and check the path is absolute and correct.
- **Engine reports `degraded`** → the model process crashed or can't start (missing GPU driver for the Vulkan build, port conflict, OOM). Check `sandy check`'s `engine` line and the model's stderr. For a CPU-only box use the `ubuntu-x64` variant.
- **`enforce_memory_limit` fails closed** → the boundary has no cgroup v2 delegation (e.g. stock Docker). Either delegate a cgroup (`Delegate=yes` on the systemd unit) or set `enforce_memory_limit: false` and rely on the supervisor's cgroup ceiling.
- **No egress at all, even to MCP servers** → you're in a boundary with no external network. That's expected for air-gap; the MCP endpoints must be reachable from inside the sandbox.
- See [Troubleshooting](troubleshooting.md) for exit codes and the `check` diagnostic.
