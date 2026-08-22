# Phase 2 Design — Standalone Service + Bundled LLM (SD-01..SD-06)

_Draft (revised after review), 2026-08-20. Phase 1 (plugin mode) is complete and
proven. This document designs Phase 2 and surfaces the decisions that need
sign-off before building. Read with `docs/PRD_Final.md` §6.6 (Mode B) and §7,
`docs/DECISIONS.md`, and `docs/NEXT_STEPS.md`._

_**Implementation status (2026-08-21):** §8 build order **steps 1–2 are done** —
the `LlmEngine` lifecycle contract, `LlamaCppEngine`/`RemoteEngine`/`StubEngine`,
the additive `llm` config fields (`model_path`, `engine` knobs, loopback
constraint), `ModelRequest`'s structured-output knobs (open #6, implemented as
(a)+(b): `responseFormat: "json"` and `jsonSchema` forwarded as
`response_format`), `SandyCheckReport.engine`, and `Sandy.close()` reaping the
model. 138/138 tests, no model or GPU required. Remaining: §8 steps 3–6
(autonomous loop, local API + `sandy serve`, service lifecycle, standalone
conformance). See `docs/DIARY.md` 2026-08-21._

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
| **Autonomous loop** | **NEW** | `src/standalone/loop.ts` (proposed): parse → run → narrate, bounded + validated |
| **Local API** | **NEW** | `src/standalone/api.ts` (proposed): loopback-only REST, bounded job store |
| **Service lifecycle** | **NEW** | `src/standalone/service.ts` + `sandy serve` CLI verb (proposed) |
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

**Still open (need a decision before build):**
1. **Model + runtime distribution.** How does the user get `llama-server` + the
   GGUF? (a) docs say "install llama.cpp and set `model_path`", (b) a
   `sandy model fetch <name>` helper that downloads from a configured source, or
   (c) a platform team bundles it. **Leaning (a) for v2** — simplest,
   air-gap-friendly (the team ships the file), no download logic in the runtime.
2. **Default model.** Which 4–8B instruct model is the documented default?
   (Needs a pick + a license/size check.) Not blocking the architecture.
3. **Resource-limit enforcement scope (§4.5).** Map caps to llama.cpp knobs now
    and let the supervisor enforce the hard ceiling (leaning), or implement the
    in-service hard bound in v2?
4. **REST vs CLI emphasis.** Both ship; confirm the REST surface list in §5 is
    the right scope for v2 (vs. CLI-only + REST later). Leaning: ship both, REST
    is thin.

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
3. **Autonomous loop** — parse (bounded + validated, §2.1) → run → narrate;
    unit-tested against `StubEngine`.
4. **Local API** — loopback-only REST over the composed Sandy, bounded job
   store (§5) + `sandy serve` verb.
5. **Service lifecycle** — lazy/eager engine start (§6), graceful shutdown
   (engine.close), model health in `check()`.
6. **Conformance for standalone** — **parameterize** the existing egress +
   sandbox matrix config templates (mode + `llm` provider/model) and run them
   against a standalone config (proves parity/egress hold, incl. the in-sandbox
   loopback model); add a stub-model end-to-end (goal → report) to the CI
   matrix.

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
- (Conditionally) a hard in-service memory ceiling for the model, if the team
  defers that to the service manager (§4.5).

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
