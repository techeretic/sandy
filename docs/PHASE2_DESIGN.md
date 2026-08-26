# Phase 2 Design — Standalone Service + Bundled LLM (SD-01..SD-06)

_Draft (revised after review), 2026-08-20. Phase 1 (plugin mode) is complete and
proven. This document designs Phase 2 and surfaces the decisions that need
sign-off before building. Read with `docs/PRD_Final.md` §6.6 (Mode B) and §7,
`docs/DECISIONS.md`, and `docs/NEXT_STEPS.md`._

_**Implementation status (2026-08-22):** **Phase 2 is complete** — §8 build order
**steps 1–6 are all done**. Steps 1–5 —
the `LlmEngine` lifecycle contract, `LlamaCppEngine`/`RemoteEngine`/`StubEngine`,
the additive `llm` config fields (`model_path`, `engine` knobs, loopback
constraint), `ModelRequest`'s structured-output knobs (open #6, implemented as
(a)+(b): `responseFormat: "json"` and `jsonSchema` forwarded as
`response_format`), `SandyCheckReport.engine`, `Sandy.close()` reaping the
model, and the **autonomous loop** (`src/standalone/loop.ts`, §2.1): bounded
+ validated parse (retry cap 3, error fed back, deterministic conservative
fallback, refuse-and-report), unchanged orchestrator run, optional clearly-
labeled narrate — wired in as `Sandy.loop` / `sandy ask "<goal>"`, with its own
audit events (`standalone_parse`/`standalone_plan`/`standalone_narrate`) and a
fail-closed `NoModelEngineError` against the host engine. **Steps 4–5
(2026-08-22):** the **loopback-only local API** (`src/standalone/api.ts`, §5) —
plain `node:http` over the composed `Sandy`, bound to `127.0.0.1` only (off-
loopback refused fail-closed), `GET /health`/`/reports`/`/audit`, `POST
/run`/`/ask` → `202`+id, `GET /jobs/:id`, SSE `GET /jobs/:id/events`, a
**bounded** job store (max pending → `429`, completed retention with oldest-
evicted → clean `404`), and a **serial** worker that redirects per-job progress
in-band (the plugin's `ProgressCollector` pattern). Plus the **service
lifecycle** (§6) — the `sandy serve` verb: eager `engine.start()`, graceful
SIGINT/SIGTERM shutdown (close the API, let the in-flight job finish, reap the
model, close MCP, flush audit); a dead model is a reported `degraded` state,
not a crash. **Step 6 (2026-08-22):** **standalone conformance** — the existing
egress + sandbox-matrix harnesses are **parameterized** (a `SANDY_MODE=standalone`
switch) so the SAME no-egress / cross-sandbox proof runs for a standalone config
with the in-sandbox loopback model: a new `conformance/stub-model.mjs` (a loopback
OpenAI-compatible stand-in for the bundled GGUF, design §9) lets `sandy ask` drive
the full loop with no real model and no external egress. Proven byte-identical
across Docker + Firejail for both modes, with the egress harness's three
assertions (EP hit / external blocked / undeclared fails closed) holding with the
 model present, plus an in-process standalone egress leg (`conformance/egress.test.ts`:
 a `standalone` config + injected model engine runs the full `ask` loop and every
 dialed URL is the one declared endpoint). The stub-model path stays CI-runnable
 with no model or GPU. **Real-model proof (2026-08-22):** the standalone path was
 then run against a **real** bundled model — Qwen3-4B-Instruct-2507 (Q4_K_M,
 Apache-2.0) via llama.cpp `llama-server` (Vulkan, GPU) — **inside a no-egress
 Firejail jail**: the model planned (validated against the legal tool catalog), the
 MCP tool ran, a provenance-tracked report was written, the model narrated
 (clearly labeled, SD-06), usage was audited, and `engine.close()` reaped the model
 (no orphan). Along the way a real integration bug was fixed: `LlamaCppEngine`
 discovered the model's port from `child.stdout`, but the real `llama-server` logs
 the `listening on http://host:PORT` line to **stderr** — it now pipes and drains
 both streams and matches the listen URL specifically. This also **settled the three
 open §7 decisions with code** (distribution → docs + `scripts/provision-model.sh`;
 default model → Qwen3-4B-Instruct-2507 Q4_K_M; resource limits → `max_cpu_percent`
 mapped to a real `--threads` cap via `threadsForCpuPercent`, hard ceiling = the
 service manager's cgroup). See `docs/MODEL.md` and `docs/DIARY.md` 2026-08-21 and
 2026-08-22 (incl. the afternoon real-model entry). **169/169 tests.**_

_**Review note (2026-08-20):** the first draft was reviewed against the actual
code. One of the review's concerns turned out to be based on a false premise and
is corrected below with a **verified fact**: in every no-egress boundary variant
we use — `docker --network none`, `docker --internal`, and `firejail --net=none`
— **loopback TCP still works** while external egress is blocked
(`loopback=OK external=BLOCKED(ENETUNREACH)`, tested on this host). That means a
`llama-server` bound to `127.0.0.1` runs *inside* the sandbox boundary and is
naturally zero-egress, so the model can (and should) sit in-sandbox. The other
review findings are real and are addressed in-place (engine lifecycle, resource
limits, conformance parameterization, parse retry bounds, engine start timing,
job-store bounds, `check()` field, model provisioning)._

## 1. What Phase 2 is

Phase 1 shipped **plugin mode**: the host LLM (Claude Code / Codex) reasons, and
Sandy is a set of sandboxed host-side tools. Phase 2 ships **standalone mode**:
Sandy runs as a **long-lived local service** with a **bundled 4–8B model** that
does the reasoning, for **offline / air-gapped** use. The same MCP layer, report
pipeline, and file semantics carry over (SD-05).

The authoritative requirements (PRD §6.6):

| ID | Requirement | Priority |
|----|-------------|----------|
| SD-01 | Runs as a long-lived background service on the host machine | P0 |
| SD-02 | Bundles a lightweight LLM (4–8B class, quantized, CPU-viable, GPU accel when present) for offline reasoning | P0 |
| SD-03 | Exposes a local API (REST or CLI) for the user to send requests | P0 |
| SD-04 | The bundled LLM is swappable (different model or remote endpoint) | P1 |
| SD-05 | Same MCP layer, same report pipeline, same file semantics as plugin mode. The model is expected to be weaker at synthesis — compensate with more structured prompting, more deterministic report scaffolding, narrower task scope | P1 |
| SD-06 | **Behavioral parity is a hard requirement on tool invocation and file operations.** Report quality is expected to differ and must be communicated to the user | P1 |

## 2. Core architectural decision

**Standalone mode is the SAME runtime spine as plugin mode, plus two new
components: an autonomous reasoning loop and a local API. The deterministic
core (MCP / files / sandbox / audit / orchestrator / report renderer) is
unchanged.**

Why: Phase 1's guarantees — provenance, no-egress, fail-closed, behavioral
identity across sandboxes — are the product's core value and are already proven
by the conformance matrix. SD-06 *demands* tool-invocation and file parity, and
the only way to guarantee that is to not fork the core. The model is the one
thing that changes between modes, and it is already isolated behind the
`LlmEngine` seam (`src/engine.ts`). Phase 2 therefore:

- implements `LlmEngine.invoke()` (a concrete bundled model) and the engine
  **lifecycle** (start/close/health — see §4.2) behind the seam;
- adds an **autonomous loop** that drives the orchestrator (the part the host
  LLM used to do in plugin mode: turn a natural-language goal into gather
  tasks + a report);
- adds a **local API** (SD-03) and the **service lifecycle** (SD-01).

Everything else is reuse. This keeps the launch success criteria (zero egress,
runs unmodified across sandboxes) intact in standalone mode. The egress and
sandbox conformance harnesses are **reused for a standalone config, with their
config templates parameterized** (mode + `llm` provider/model) — see §9; they
do not need changes to their assertions, only to the config they generate.

### 2.1 The autonomous reasoning loop (the one genuinely new behavior)

In plugin mode the **host LLM** decides what to gather and writes the narrative.
In standalone mode Sandy must do that itself, using the bundled model. The loop:

```
goal (natural language)
   │
   ▼
[parse]   LlmEngine.invoke({ prompt, responseFormat: "json" })
   │        → structured { gather tasks, report spec }
   │        (validated against orchestratorRequestSchema — fail closed on
   │         anything the model emits that isn't a legal request)
   │        (bounded retry on an illegal plan; deterministic fallback on
   │         exhaustion — see "parse robustness" below)
   ▼
[run]     Orchestrator.run() → claims + gaps + Markdown report   (unchanged)
   │        (deterministic: provenance, gaps, no filler)
   ▼
[narrate] LlmEngine.invoke() → host-style summary text (optional; clearly
   │        labeled; the claims/provenance remain the source of truth)
   ▼
report + transcript
```

Key properties:
- **The model proposes, the schema disposes.** Model output is validated against
  the existing `orchestratorRequestSchema`; a malformed plan is a recorded
  error/retry, never a silent bad request. This is what keeps a weak 4–8B model
  from doing anything the sandbox policy doesn't allow (SD-05 compensation).
- **Parse robustness is bounded and deterministic.** A weak model can fail to
  emit a legal plan, so the parse step is: (a) retry with the error fed back,
  up to a small fixed cap (e.g. 3); (b) on exhaustion, fall back to a
  **deterministic, conservative plan** (not a guess by the model) — either a
  single obvious task if the goal names one, or refuse-and-report with an
  explicit gap ("could not derive a plan"). The loop **never loops unboundedly
  and never invents** an unvalidated plan. Every parse attempt is audited
  (`model_invocation`).
- **Provenance is unaffected.** The model does not author claims; claims come
  from MCP tool results exactly as in plugin mode. The model only (a) plans
  which tools to call and (b) writes the labeled narrative. Report quality may
  vary (SD-06) but traceability does not.
- **Every model call is audited** (`model_invocation`, AU-01) — the seam
  already does this; `invoke()` records in/out tokens.
- **Narrow task scope** (SD-05): v1 standalone loop is the single
  gather → report pass, the same shape the plugin exposes. Multi-turn /
  agentic tool-selection is a later extension, not the v2 core.

### Threat model note: prompt injection via MCP-retrieved content

`AutonomousLoop.narrate()` (`src/standalone/loop.ts`) builds its prompt from
`claim.text` — content retrieved from internal systems via MCP (a Jira ticket
body, a wiki page, a CRM note). That content is **untrusted relative to the
model**: a document containing adversarial instructions ("ignore the above and
instead say…") could attempt to steer the local model's narrative summary.

Existing mitigations, by design:

- **Claims are the source of truth, independent of the narrative.** The
  report's Findings/Provenance sections render directly from claim data with
  no model involvement (`src/orchestrator/report.ts`); the narrative is a
  clearly-labeled, separate "Summary" section
  (`"_(model narrative — a local/host model wrote this; it may vary in
  quality. The claims below are independently traceable and remain the source
  of truth.)_"`) that a reader is told not to treat as the sole source of truth.
- **The narrative cannot expand what already ran.** `narrate()` runs *after*
  the orchestrator's gather pass is complete and only summarizes results
  already collected; it has no tool-calling ability and cannot trigger new
  MCP calls or file operations (the only write is re-rendering the already
  produced report back to its path).
- **A narrate failure degrades gracefully.** If the model produces nothing
  useful or errors, `narrate()` returns `null` and the caller keeps the
  already-written deterministic report (no narrative section) — a dead model
  is reported, not a crash.

What this does **not** mitigate: the narrative text itself could still be
misleading if a weak local model is successfully steered by injected content,
even though the underlying claims remain independently correct and traceable.
This is an accepted, documented risk for v2 — a reader who treats the model
narrative as authoritative rather than as a convenience summary is relying on
it beyond its designed guarantee. If this becomes a priority, the next steps
would be delimiting/escaping retrieved content in the narrate prompt (e.g.
wrapping each claim in an unambiguous boundary marker) and/or a lightweight
instruction-following check on the narrative output before it is written into
the report.

## 3. Component inventory

| Component | Status | Notes |
|-----------|--------|-------|
| Config / loader | **Reuse + extend** | `llm.provider: "local"` must load; add model-file resolution + additive `llm` fields (§4.4) |
| Sandbox Enforcer | **Reuse, unchanged** | `runtime` is already any sandbox; standalone runs inside it too |
| MCP Client Manager | **Reuse, unchanged** | still the only egress path; NetworkGuard unchanged |
| File Manager | **Reuse, unchanged** | SD-06 parity is automatic |
| Audit Logger | **Reuse, unchanged** | `model_invocation` already defined and wired |
| Orchestrator + report | **Reuse, unchanged** | the model plugs in around it, not into it |
| `LlmEngine` (`src/engine.ts`) | **Extend** | implement `invoke()` for a local backend **and** add a lifecycle contract (start/close/health, §4.2); extend `ModelRequest` for structured output; `createLlmEngine` already fails closed for `local`/`remote` until then |
| `SandyCheckReport` (`src/sandy.ts`) | **Extend** | add an `engine` health field (loaded/ready/dead + reason) so `sandy check` surfaces model health |
| **Autonomous loop** | **Done (2026-08-22)** | `src/standalone/loop.ts`: parse → run → narrate, bounded + validated + deterministic fallback; `Sandy.loop` / `sandy ask` |
| **Local API** | **Done (2026-08-22)** | `src/standalone/api.ts`: loopback-only REST (off-loopback refused), bounded job store, serial worker, SSE progress |
| **Service lifecycle** | **Done (2026-08-22)** | `sandy serve` CLI verb (`runServe` in `src/cli.ts`): eager engine start, graceful SIGINT/SIGTERM shutdown |
| Model runtime | **NEW** | llama.cpp (see §4) |

## 4. The bundled model (SD-02, SD-04)

### 4.0 Where the model sits: **inside the sandbox, on loopback** (decided)

The first draft left this open and under-weighted it. It is actually a hard
compatibility question, and it is **resolved**: `llama-server` runs **inside the
same sandbox** as Sandy, bound to `127.0.0.1` on an ephemeral port. This is
verified to work in every no-egress boundary we use — loopback stays up while
external egress is blocked:

| Boundary (the conformance ones) | Loopback | External egress |
|---|---|---|
| `docker --network none` | `OK` | `BLOCKED(ENETUNREACH)` |
| `docker --internal` | `OK` | `BLOCKED(ENETUNREACH)` |
| `firejail --net=none` | `OK` | `BLOCKED(ENETUNREACH)` |

Consequences, all favorable: the model's egress is **zero by construction**
(its only path is loopback to its own process), it is the **least-privileged**
placement, and it means the **existing no-egress conformance keeps applying** to
the standalone service. The extra subprocess is declared in the capability
manifest's subprocess list (the mechanism already exists), so the reduced-mode
report will say so rather than fail.

> **Model provisioning is out-of-band.** Getting `llama-server` + the GGUF onto
> the machine is an *install-time* step (a team ships the file / the user
> installs it); it never flows through the `NetworkGuard`'d runtime, so it is
> not an egress path. The runtime only *reads* `model_path` from disk.

### 4.1 Backend: llama.cpp, driven as a **subprocess** (recommended)

Q2 already chose "Phase 2 local model serving via llama.cpp bindings." The open
sub-decision is *how* Node talks to llama.cpp.

| Option | Pros | Cons |
|--------|------|------|
| **A. Subprocess `llama-server` (llama.cpp), HTTP on a local port** (recommended) | No native build in our dep tree; model + server isolated in their own process (a model crash can't take down the service); GPU/CPU accel is llama.cpp's job; swappable (SD-04) by pointing at any OpenAI-compatible local server; matches our existing stdio/subprocess pattern; **loopback-only, so zero-egress (§4.0)** | One more managed child process; a localhost port to manage |
| B. Native N-API binding (e.g. `node-llama-cpp`) | In-process, no port | Native compile step in our install (fragile across platforms/GPU); weaker "swappable" story; model crash = service crash |
| C. Ship our own inference | — | Out of scope; that *is* writing llama.cpp |

**Recommendation: A.** It is the lowest-risk path to an offline, CPU-viable,
GPU-accelerated-when-present model, it keeps the npm install clean, it makes
SD-04 trivial (any OpenAI-compatible endpoint — local `llama-server` *or* a
remote one — is a config change), and the loopback transport is verified
compatible with our sandbox boundary (§4.0). The `LlmEngine` interface abstracts
this: a `LlamaCppEngine` wraps the server process + HTTP calls; a `RemoteEngine`
(the same HTTP client pointed at a remote endpoint) covers SD-04's "remote
endpoint" half for free.

### 4.2 How it plugs into the existing seam — including the **lifecycle contract**

`createLlmEngine(llm, audit)` currently returns `HostLlmEngine` for `host` and
throws for `local`/`remote`. Phase 2 replaces those throws with real engines,
**and extends the seam with a lifecycle** (the first draft omitted this, and it
is the most under-specified load-bearing part). Today `LlmEngine`
(`src/engine.ts:63`) is only `record` + `invoke`, and `Sandy.close()`
(`src/sandy.ts:253`) closes only the MCP manager + audit — nothing reaps a model
process. The revised seam:

```ts
interface LlmEngine {
  readonly provider: string;
  record(invocation: ModelUsage): AuditEvent;            // unchanged
  invoke(request: ModelRequest): Promise<ModelResult>;   // ModelRequest extended, below
  /** Start the backend (e.g. spawn llama-server). Idempotent. Resolves when
   *  ready, or throws fail-closed if the model/runtime can't be brought up. */
  start(): Promise<void>;
  /** Is the backend up and healthy right now? (feeds SandyCheckReport.engine) */
  isReady(): boolean;
  /** Stop the backend (kill the child), flush. Idempotent. Called by
   *  Sandy.close() and on service shutdown. */
  close(): Promise<void>;
}
```

- `provider: "local"` → `LlamaCppEngine`: `start()` spawns `llama-server`
  (loopback, ephemeral port), waits for readiness, records readiness in the
  audit; `invoke()` reuses the one instance; `close()` stops the child.
- `provider: "remote"` → `RemoteEngine`: same interface, no child process
  (`start()` is a connectivity no-op/probe; `close()` is a no-op); auth via the
  existing `${ENV_REF}` secret path, never stored.
- **`Sandy.close()` is extended** to also `await engine.close()`, and the service
  shutdown path (SIGINT/SIGTERM) does the same, so a model process is never
  orphaned (the same class of leak we already fixed for a failed MCP connect).
- Both implement the interface and are injected through the same
  `SandyDeps.engine` escape hatch for tests. A **stub engine** (canned
  completion + fixed tokens; `start`/`isReady` trivially ready; `close` no-op)
  is the test double for the loop and API, so the standalone suite runs in CI
  **without** a model or GPU.

### 4.3 Model fit (SD-02)

Target a 4–8B instruct model, quantized (e.g. Q4/Q5 GGUF), CPU-viable. Concrete
default is an open question (§7) — the config should name the model, not hard
code it (SD-04).

### 4.4 Config: model resolution (additive, fail-closed)

`llm.provider: "local"` currently requires `model` (a name) and allows
`endpoint`/`api_key`. To run offline we need to know **where the model file is**
and how to start the runtime. Proposed additive schema (new fields only —
existing `host`/`local` configs keep loading):

```jsonc
"llm": {
  "provider": "local",
  "model": "llama-3.1-8b-instruct-q4",   // logical name (SD-04)
  "model_path": "/models/llama-3.1-8b-q4_k_m.gguf",  // NEW: where the file is
  "engine": {                             // NEW, optional runtime knobs
    "type": "llama-server",               // or "openai-compatible"
    "command": ["llama-server"],          // default; absolute or PATH-resolved
    "port": 0,                            // 0 = pick a free loopback port
    "host": "127.0.0.1"                   // loopback only; off-loopback refused
  }
}
```

- `model_path` is validated as an absolute path (reuses `absolutePathSchema`)
  and **must exist at `start()` → fail closed if missing** (never "try and
  hope"). The loader validates the reference shape; existence is checked at
  engine start (the file may be provisioned after config is written).
- `engine.host` is constrained to `127.0.0.1`/`localhost`; a non-loopback value
  is a **config error** (fail closed), mirroring the local API's loopback rule.
- `port: 0` = pick a free loopback port (default); the engine records the bound
  port in the `SandyCheckReport.engine` field.
- Exact field names are a minor open item (§7); the *shape* (name + path +
  runtime knobs, loopback-constrained) is the decision.

### 4.5 Resource limits (review finding — currently unenforced)

`sandbox.max_memory_mb` / `max_cpu_percent` are declared in the schema
(`src/config/schema.ts:178`) but **nothing in `src/` currently enforces them** —
they are manifest/report data, not runtime limits. A 4–8B model is exactly the
thing that would blow a memory cap, so the design must not silently assume the
sandbox bounds the model. Decision: **model resource enforcement is in scope as
a v2 concern, via the runtime's native mechanism** (e.g. `llama-server`'s own
`--ctx-size`/`--threads`/memory settings derived from `max_memory_mb`, plus a
host-level cgroup/`memory.max` for the process group where the service manager
applies it). For **v2 scope**: (a) map the declared caps to llama.cpp startup
knobs where it's a real lever, and (b) document that the *hard* memory bound is
the service manager's cgroup (we set the knobs; the supervisor enforces the
ceiling). If the team wants the hard bound in v2, that is a small addition —
flagged here so it isn't silently unbounded.

## 5. The local API (SD-03)

**Decision: a loopback-only HTTP API, exposed alongside the existing CLI.**
The CLI (`sandy run`) already exists and stays the primary local interface; the
service adds a REST surface for a UI / other local tools.

- **Bind to `127.0.0.1` only.** This is a security invariant, not a preference:
  the service is per-user (Q5) and must never become a network-exposed endpoint.
  (The egress side is already guaranteed; this closes the ingress side.)
- **No auth in v2** because it is loopback-only and single-user; document that
  binding off-loopback is refused (fail closed). If a later need arises, it is a
  config-gated addition, not a default.
- **Surface** (maps 1:1 onto the existing primitives — no new capability):
  - `GET  /health`            → `sandy.check()` (same `SandyCheckReport`, now incl. `engine`)
  - `POST /run`               → body = `orchestratorRequestSchema`; `202` + job id
  - `GET  /jobs/:id`          → status → result (claims, gaps, reportPath)
  - `GET  /reports`           → list written reports (confined dir)
  - `GET  /audit`             → transcript export (AU-03)
  - streaming: `GET /jobs/:id/events` (SSE) for the Q4 progress, mirroring the
    in-band progress the plugin uses.
- **The request body is validated by the same `orchestratorRequestSchema`** the
  CLI and plugin use, so there is exactly one definition of a legal request.
- **Job store is bounded.** `POST /run` is async (`202` + id) because a report
  can take time, so the service needs a job registry the synchronous
  `Orchestrator.run()` doesn't provide. It is **bounded** to prevent slow
  growth in a long-lived process: a fixed max in-flight + a bounded retention
  (e.g. keep the most recent N completed jobs, evict oldest; N configurable,
  default e.g. 100). `GET /jobs/:id` on an evicted id is a clean `404`, not a
  crash. (One-instance-per-user keeps the working set small, but doesn't bound
  it within a long session — the cap does that.)
- Transport is a plain `node:http` server (no framework dep) wrapped over the
  composed `Sandy` — the same `createSandy` spine, one instance, reused across
  requests (like the plugin's `SessionCache`).

## 6. Service lifecycle (SD-01)

- New CLI verb: `sandy serve` (alongside `check` / `run`). Starts: config →
  enforcer → audit → **engine.start()** → MCP → files → loop → API. Reuses
  `createSandy`, adding the engine-start and API-start steps.
- **Engine start timing: lazy by default, eager on demand.** `createSandy`
  currently builds the engine object at startup (`src/sandy.ts:178`) — but a
  4–8B model is expensive to bring up, and it must not start for a
  `sandy check` or a plugin/CLI `run` that doesn't use a model. So the engine
  object is constructed eagerly (cheap, no process), but `engine.start()` is
  **lazy**: it runs on the first `invoke()` and on `sandy serve` (which wants a
  ready model for the API), not on `createSandy`/`check`. `sandy check` reports
  `engine.status` as `"not-started"` (or `"ready"`/`"degraded"` once started)
  without forcing a model load. This keeps the existing conformance `check` step
  cheap.
- **Long-lived and supervised**: stays up until a clean shutdown. Graceful
  shutdown on `SIGINT`/`SIGTERM` (close API, stop the loop, **`engine.close()`**,
  close MCP, flush audit). A dead model is **reported, not a crash**: it is
  surfaced in `SandyCheckReport.engine` (`status: "degraded"`, reason) and the
  loop reports a `server-unavailable`-style gap rather than dying.
- "Background service" = it is designed to be launched by the platform's
  service manager (systemd/launchd) or a supervisor; Sandy itself is a
  well-behaved foreground process with clean signals and a health endpoint. We
  do not fork/detach ourselves (that's the supervisor's job, per Q5 one
  instance per user).

## 7. Decisions — status

**Resolved during review** (no longer open):
- **Model placement** → in-sandbox, on loopback (§4.0); verified compatible with
  all no-egress boundaries; zero-egress + least-privilege by construction.
- **Engine lifecycle** → `start`/`isReady`/`close` added to `LlmEngine`, wired
  into `Sandy.close()` and service shutdown (§4.2).
- **Engine start timing** → lazy by default; eager on `sandy serve` (§6).
- **Parse robustness** → bounded retry + deterministic fallback (§2.1).

**Implemented (2026-08-22, §8 steps 4–5):**
- **Local API (SD-03)** → built: `src/standalone/api.ts` (`LocalApi`,
  `BoundedJobStore`, `createLocalApi`). Plain `node:http` (no framework) over the
  composed `Sandy`. **Loopback-only**: binds `127.0.0.1`/`localhost`/`::1`; any
  other host is refused fail-closed by `LoopbackBindError` before a socket opens
  (the ingress-side half of the no-exposure guarantee). Surface maps 1:1 onto
  existing primitives: `GET /health` → `check()`, `POST /run` (validated by the
  same `orchestratorRequestSchema`) and `POST /ask` → `202` + job id, `GET
  /jobs/:id` → status/result (clean `404` when evicted), `GET /reports` (confined
  dir), `GET /audit` (transcript, AU-03), SSE `GET /jobs/:id/events` (Q4
  progress). The job store is **bounded** — a max pending (`429` when full) and a
  completed retention that evicts the oldest finished job (so a long-lived
  process can't grow without limit; §5). A **serial** worker runs one job at a
  time (the composed `Sandy` has one progress sink; this mirrors the plugin's
  sequential `ProgressCollector`), redirecting the orchestrator's **and** loop's
  progress to the active job in-band + over SSE, then restoring the prior sink.
  `close()` stops the server, lets the in-flight job finish, and releases the port.
- **Service lifecycle (SD-01)** → built: `sandy serve` (`runServe` in
  `src/cli.ts`): config → enforcer → audit → **eager `engine.start()`** (a
  service wants a ready model) → MCP → API, then long-lived until SIGINT/SIGTERM.
  Graceful shutdown closes the API (letting the in-flight job finish), then
  `Sandy.close()` reaps the model, closes MCP, and flushes the audit — in that
  order, so nothing is orphaned. Engine start stays **lazy** for `check`/`run`/
  `ask` (a `sandy check` never forces a model load); a dead model is a reported
  `degraded` state in `/health`, never a crash (§6).

**Implemented (2026-08-22, §8 step 3):**
- **Autonomous loop** → built: `src/standalone/loop.ts` (`AutonomousLoop`), the
  §2.1 parse → run → narrate. Parse is bounded (default 3 attempts, the error
  fed back on retry) and validated against `orchestratorRequestSchema` **and**
  the manifest's legal tool catalog (the model can only plan what the policy
  already allows). On exhaustion a deterministic conservative fallback (a single
  task when the goal names exactly one known tool) or refuse-and-report with an
  explicit gap — never unbounded, never an invented plan. The run is the
  unchanged `Orchestrator`; narrate is an optional clearly-labeled model summary
  re-rendered into the report's Summary slot. A dead model degrades (fallback /
  no narrative), never a crash; every model call is audited (`model_invocation`)
  and each loop step is audited (`standalone_parse`/`standalone_plan`/
  `standalone_narrate`). Exposed as `Sandy.loop` / `sandy ask "<goal>"`;
  `NoModelEngineError` fails closed against the host (plugin) engine.

**Implemented (2026-08-21, §8 steps 1–2):**
- **Engine lifecycle** → built: `start`/`isReady`/`status`/`close` on `LlmEngine`;
  `LlamaCppEngine` (subprocess on loopback, fail-closed on missing model,
  crash = `degraded`), `RemoteEngine` (guard-checked before dial), `StubEngine`
  (CI double); `Sandy.close()` reaps the backend; `SandyCheckReport.engine`
  added.
- **Config field names (#4)** → settled by the implementation as sketched in
  §4.4: `llm.model_path` + `llm.engine` (`type`/`command`/`host`/`port`),
  `host` loopback-only, `local` requires `model` + `model_path`.
- **Structured-output mechanism (#6)** → implemented as (a)+(b): `ModelRequest`
  carries `responseFormat: "json"` and an optional `jsonSchema`; both backends
  forward them as `response_format` (`json_object` / `json_schema`).

**Settled (2026-08-22, validated with a real model):**
1. **Model + runtime distribution** → **(a) docs-based install + an
   `scripts/provision-model.sh` helper** (SHA256-pinned, fail-closed on
   mismatch). The runtime never downloads a model — provisioning is an
   install-time, out-of-band step (air-gap-friendly; the file is copied onto the
   host). See `docs/MODEL.md`.
2. **Default model** → **Qwen3-4B-Instruct-2507, Q4_K_M GGUF** (~2.4GB,
   **Apache-2.0**). An instruct (chat/agent) model in the 4–8B class; the
   license/size check is cleared. Proven end-to-end: a real `sandy ask` against
   this model (Vulkan/GPU on an RTX 5090, in-sandbox, zero egress) produced a
   model-planned run, a provenance-tracked report, and a labeled narrative.
   See `docs/MODEL.md`.
   3. **Resource-limit enforcement scope (§4.5)** → **map caps to real levers now;
    the hard ceiling is the service manager's cgroup; opt-in in-service bound
    (issue #18).** `sandbox.max_cpu_percent` is mapped to a llama.cpp `--threads`
    budget for the local model (`threadsForCpuPercent` in `src/engine.ts`, wired
    in `createSandy`); a cap of 100 passes no flag (no effective limit), any
    lower value reduces the budget (tighten-never-loosen). The DEFAULT hard
    memory ceiling is the supervisor's cgroup (`memory.max` / `--memory` /
    `MemoryMax=`). The flagged in-service addition is now implemented:
    `sandbox.enforce_memory_limit: true` (default off) wraps the model's process
    group in a cgroup v2 child with `memory.max` = `max_memory_mb`
    (`wrapProcessInMemoryCgroup` in `src/memory-bound.ts`). It requires cgroup
    delegation and fails closed (a degraded engine) where it can't be applied —
    never silently unbounded.

**Resolved by implementation (2026-08-22):**
- **#5 (old) REST vs CLI emphasis** → both ship, as the design leaned: the CLI
  (`check`/`run`/`ask`/`serve`) stays the primary local interface and the REST
  surface in §5 is thin and shipped 1:1 (`/health`, `/run`, `/ask`, `/jobs/:id`,
  `/jobs/:id/events`, `/reports`, `/audit`).

**Resolved by implementation (2026-08-21, no longer open):**
- **#4 (old) Exact additive `llm` config fields** → shipped as §4.4 sketches
  them: `model_path` + `engine` block (see "Implemented" above).
- **#6 (old) Structured-output mechanism** → (a)+(b) implemented at the seam
  (`responseFormat`/`jsonSchema` → `response_format`); the loop can rely on it.

## 8. Build order (when approved)

1. **`LlmEngine` lifecycle + local backend** — ~~add `start`/`isReady`/`close` to
    the interface; `LlamaCppEngine` (+ `RemoteEngine` for SD-04); extend
    `ModelRequest` for structured output (open #6); a `StubEngine` test double;
    `createLlmEngine` wired so `local`/`remote` construct instead of throwing;
    `Sandy.close()` and `SandyCheckReport` extended.~~ **DONE (2026-08-21)** —
    all of the above, *tested with no model*.
2. **Config extension** — ~~additive `llm` fields (§4.4) + loopback constraint +
    fail-closed model-file check at `start()`.~~ **DONE (2026-08-21)** —
    `model_path` + `engine` block as sketched in §4.4; `host` constrained to
    loopback; `local` requires `model` + `model_path`.
3. **Autonomous loop** — ~~parse (bounded + validated, §2.1) → run → narrate;
    unit-tested against `StubEngine`.~~ **DONE (2026-08-22)** —
    `src/standalone/loop.ts`: bounded (≤3) validated parse with the error fed
    back, deterministic conservative fallback (single named tool) or
    refuse-and-report with an explicit gap; run through the unchanged
    `Orchestrator`; optional clearly-labeled narrate re-rendered into the
    report. Wired in as `Sandy.loop` / `sandy ask "<goal>"`; a dead model
    degrades (fallback / no narrative), never crashes; fails closed against the
    host engine. Unit-tested with a scripted in-process engine (no model/GPU).
4. **Local API** — ~~loopback-only REST over the composed Sandy, bounded job
    store (§5) + `sandy serve` verb.~~ **DONE (2026-08-22)** —
    `src/standalone/api.ts`: `node:http` bound to `127.0.0.1` only (off-loopback
    refused), `GET /health`/`/reports`/`/audit`, `POST /run`/`/ask` → `202`+id,
    `GET /jobs/:id`, SSE `GET /jobs/:id/events`; **bounded** `BoundedJobStore`
    (max pending → `429`, completed retention + oldest-evicted → `404`); a
    **serial** worker redirects the orchestrator's + loop's progress per job.
5. **Service lifecycle** — ~~lazy/eager engine start (§6), graceful shutdown
    (engine.close), model health in `check()`.~~ **DONE (2026-08-22)** —
    `sandy serve` verb: eager `engine.start()`, graceful SIGINT/SIGTERM shutdown
    (API → in-flight job → `engine.close()` → MCP → audit flush); engine start
    stays **lazy** for `check`/`run`/`ask`; a dead model is a reported `degraded`
    state, never a crash.
6. **Conformance for standalone** — ~~**parameterize** the existing egress +
    sandbox matrix config templates (mode + `llm` provider/model) and run them
    against a standalone config (proves parity/egress hold, incl. the in-sandbox
    loopback model); add a stub-model end-to-end (goal → report) to the CI
    matrix.~~ **DONE (2026-08-22)** — the harnesses gain a `SANDY_MODE=standalone`
    switch (a `conformance/stub-model.mjs` loopback stand-in for the model, §9),
    so `SANDY_MODE=standalone` runs `sandy check` + `sandy ask` under both
    boundaries and reuses the egress harness's three assertions; the CI matrix
    now runs both modes (4 legs) and proves each mode byte-identical across
    Docker + Firejail. Verified locally with both boundaries present.

## 9. Conformance & test strategy

- The **stub engine** makes the whole standalone path CI-runnable with no model
  download and no GPU: loop, API, and lifecycle are tested deterministically.
- The **existing egress + sandbox conformance** is **reused, with its config
  templates parameterized** (the harnesses currently hardcode `"mode":
  "plugin", "llm": { "provider": "host" }` — `conformance/sandbox-matrix.sh:94`,
  `conformance/run-docker.sh:99` — so they need their generated config to accept
  a standalone `llm` block; the *assertions* are unchanged). Passing them for a
  standalone config is the proof that adding a model didn't break the no-egress
  / cross-sandbox guarantees (SD-05/SD-06 at the security level). The in-sandbox
  loopback model placement (§4.0) is what makes this work in `--net=none` /
  `--internal` / `--network none`.
- A **model-quality note** (SD-06) is surfaced to the user at report time
  ("generated by a local model; quality may vary"), per the PRD.

## 10. Non-goals for v2

- Write-back to internal systems (still Q6-deferred; the gate contract exists).
- Extra report formats (HTML/DOCX/XLSX/PDF) — still deferred.
- Recurring report templates (RG-08) — still deferred.
- Multi-turn agentic planning beyond the single gather→report pass.
- Multi-user / network-exposed API (one instance per user, loopback only).
- ~~A hard in-service memory ceiling for the model, if the team defers that to
  the service manager (§4.5)~~ — now implemented as an opt-in
  (`sandbox.enforce_memory_limit`, issue #18); the default ceiling remains the
  service manager's cgroup.

## 11. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Weak 4–8B model produces bad plans | Model output validated against the request schema; **bounded retry + deterministic fallback** (§2.1); deterministic scaffolding carries the report; narrow scope (SD-05) |
| Model/quality variance surprises users | Surface a "local model, quality may vary" note (SD-06); provenance unaffected |
| Model runtime is heavy/fragile / orphaned | Subprocess isolation (§4.1); `engine.start`/`close` wired into `Sandy.close()` + shutdown so no orphan (§4.2); model health in `check()`, dead model = gap not crash (§6) |
| Model exceeds the memory/CPU cap | Caps mapped to llama.cpp knobs; hard ceiling via service-manager cgroup (§4.5) — not silently unbounded |
| Model transport breaks a no-egress boundary | **Verified**: loopback works in `--network none` / `--internal` / `--net=none` while egress is blocked (§4.0); loopback-only, off-loopback refused |
| Local API becomes a leak | Loopback-only, refused off-loopback, no non-loopback bind |
| Long-lived job store grows unbounded | Bounded job store + retention eviction (§5) |
| Air-gap: no way to get the model | `model_path` config + out-of-band provisioning, team-shipped file (open #1, leaning docs-based); never a runtime egress path |
