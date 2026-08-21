# Phase 2 Design — Standalone Service + Bundled LLM (SD-01..SD-06)

_Draft, 2026-08-20. Phase 1 (plugin mode) is complete and proven. This document
designs Phase 2 and surfaces the decisions that need sign-off before building.
Read with `docs/PRD_Final.md` §6.6 (Mode B) and §7, `docs/DECISIONS.md`, and
`docs/NEXT_STEPS.md`._

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

- implements `LlmEngine.invoke()` (a concrete bundled model) — the seam's
  purpose;
- adds an **autonomous loop** that drives the orchestrator (the part the host
  LLM used to do in plugin mode: turn a natural-language goal into gather
  tasks + a report);
- adds a **local API** (SD-03) and the **service lifecycle** (SD-01).

Everything else is reuse. This keeps the launch success criteria (zero egress,
runs unmodified across sandboxes) intact in standalone mode — the egress and
sandbox conformance harnesses should run for standalone config unchanged.

### 2.1 The autonomous reasoning loop (the one genuinely new behavior)

In plugin mode the **host LLM** decides what to gather and writes the narrative.
In standalone mode Sandy must do that itself, using the bundled model. The loop:

```
goal (natural language)
   │
   ▼
[parse]   LlmEngine.invoke() → structured { gather tasks, report spec }
   │        (validated against orchestratorRequestSchema — fail closed on
   │         anything the model emits that isn't a legal request)
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
| Config / loader | **Reuse + extend** | `llm.provider: "local"` must load; add model-file resolution (see §4.4) |
| Sandbox Enforcer | **Reuse, unchanged** | `runtime` is already any sandbox; standalone runs inside it too |
| MCP Client Manager | **Reuse, unchanged** | still the only egress path; NetworkGuard unchanged |
| File Manager | **Reuse, unchanged** | SD-06 parity is automatic |
| Audit Logger | **Reuse, unchanged** | `model_invocation` already defined and wired |
| Orchestrator + report | **Reuse, unchanged** | the model plugs in around it, not into it |
| `LlmEngine` (`src/engine.ts`) | **Extend** | implement `invoke()` for a local backend; `createLlmEngine` already fails closed for `local` until then |
| **Autonomous loop** | **NEW** | `src/standalone/loop.ts` (proposed): parse → run → narrate |
| **Local API** | **NEW** | `src/standalone/api.ts` (proposed): REST on loopback |
| **Service lifecycle** | **NEW** | `src/standalone/service.ts` + `sandy serve` CLI verb (proposed) |
| Model runtime | **NEW** | llama.cpp (see §4) |

## 4. The bundled model (SD-02, SD-04)

### 4.1 Backend: llama.cpp, driven as a **subprocess** (recommended)

Q2 already chose "Phase 2 local model serving via llama.cpp bindings." The open
sub-decision is *how* Node talks to llama.cpp.

| Option | Pros | Cons |
|--------|------|------|
| **A. Subprocess `llama-server` (llama.cpp), HTTP on a local port** (recommended) | No native build in our dep tree; model + server isolated in their own process (a model crash can't take down the service); GPU/CPU accel is llama.cpp's job; swappable (SD-04) by pointing at any OpenAI-compatible local server; matches our existing stdio/subprocess pattern | One more managed child process; a localhost port to manage |
| B. Native N-API binding (e.g. `node-llama-cpp`) | In-process, no port | Native compile step in our install (fragile across platforms/GPU); hardens the "swappable" story; model crash = service crash |
| C. Ship our own inference | — | Out of scope; that *is* writing llama.cpp |

**Recommendation: A.** It is the lowest-risk path to an offline, CPU-viable,
GPU-accelerated-when-present model, it keeps the npm install clean, and it makes
SD-04 trivial (any OpenAI-compatible endpoint — local `llama-server` *or* a
remote one — is a config change). The `LlmEngine` interface already abstracts
this: a `LlamaCppEngine` wraps the server process + HTTP calls; a `RemoteEngine`
(the same HTTP client pointed at a remote endpoint) covers SD-04's "remote
endpoint" half for free.

> The model binary/weights are **not** committed to this repo. The service
> resolves the model file from config (§4.4) and the runtime (`llama-server`)
> from PATH or a declared location. Distribution of the service + model is a
> packaging question (§7, open).

### 4.2 How it plugs into the existing seam

`createLlmEngine(llm, audit)` currently returns `HostLlmEngine` for `host` and
throws for `local`/`remote`. Phase 2 replaces those two throws with real engines:

- `provider: "local"` → `LlamaCppEngine` (owns `llama-server` lifecycle: spawn
  on first `invoke()` or at service start, reuse across calls, stop on
  `close()`; records tokens each call).
- `provider: "remote"` → `RemoteEngine` (same HTTP client, different base URL;
  auth via the existing `${ENV_REF}` secret path, never stored).

Both implement `invoke()` and `record()` and are injected through the same
`SandyDeps.engine` escape hatch for tests. A **stub engine** (returns canned
completion + fixed tokens) is the test double for the loop and API, so the
standalone suite runs in CI **without** a model or GPU.

### 4.3 Model fit (SD-02)

Target a 4–8B instruct model, quantized (e.g. Q4/Q5 GGUF), CPU-viable. Concrete
default is an open question (§7) — the config should name the model, not hard
code it (SD-04).

### 4.4 Config: model resolution

`llm.provider: "local"` currently requires `model` (a name) and allows `endpoint`/`api_key`. To run offline we need to know **where the model file is**. Proposed additive, fail-closed schema:

```jsonc
"llm": {
  "provider": "local",
  "model": "llama-3.1-8b-instruct-q4",   // logical name (SD-04)
  "model_path": "/models/llama-3.1-8b-q4_k_m.gguf",  // NEW: where the file is
  "engine": { "type": "llama-server", "port": 0 }    // NEW, optional: runtime knobs
}
```

- `model_path` is validated as an absolute path (reuses `absolutePathSchema`)
  and must exist at startup → fail closed if missing (never "try and hope").
- `port: 0` = pick a free localhost port (default); the runtime never listens
  on a non-loopback interface.
- Exact field names are a minor open item (§7); the *shape* (name + path +
  runtime knobs) is the decision.

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
  - `GET  /health`            → `sandy.check()` (same `SandyCheckReport`)
  - `POST /run`               → body = `orchestratorRequestSchema`; 202 + job id
  - `GET  /jobs/:id`          → status → result (claims, gaps, reportPath)
  - `GET  /reports`           → list written reports (confined dir)
  - `GET  /audit`             → transcript export (AU-03)
  - streaming: `GET /jobs/:id/events` (SSE) for the Q4 progress, mirroring the
    in-band progress the plugin uses.
- **The request body is validated by the same `orchestratorRequestSchema`** the
  CLI and plugin use, so there is exactly one definition of a legal request.
- Transport is a plain `node:http` server (no framework dep) wrapped over the
  composed `Sandy` — the same `createSandy` spine, one instance, reused across
  requests (like the plugin's `SessionCache`).

## 6. Service lifecycle (SD-01)

- New CLI verb: `sandy serve` (alongside `check` / `run`). Starts: config →
  enforcer → audit → **engine (model ready)** → MCP → files → loop → API.
  Reuses `createSandy`, adding the engine-start and API-start steps.
- **Long-lived and supervised**: stays up until a clean shutdown. Graceful
  shutdown on `SIGINT`/`SIGTERM` (close MCP, stop `llama-server`, flush audit).
  Model process health is part of `check()` (a dead model = reported degraded,
  not a crash).
- "Background service" = it is designed to be launched by the platform's
  service manager (systemd/launchd) or a supervisor; Sandy itself is a
  well-behaved foreground process with clean signals and a health endpoint. We
  do not fork/detach ourselves (that's the supervisor's job, per Q5 one
  instance per user).

## 7. Open questions (need a decision before build)

1. **Model + runtime distribution.** How does the user get `llama-server` + the
   GGUF? (a) docs say "install llama.cpp and set `model_path`", (b) a
   `sandy model fetch <name>` helper that downloads from a configured source,
   or (c) a platform team bundles it. **Leaning (a) for v2** — simplest,
   air-gap-friendly (the team ships the file), no download logic in the runtime.
2. **Default model.** Which 4–8B instruct model is the documented default?
   (Needs a pick + a license/size check.) Not blocking the architecture.
3. **Tiered models (PRD §12 open item).** Offer multiple sizes/quality tiers?
   **Leaning no for v2** — SD-04 swappability already lets a user point at a
   bigger model; a first-class tier UI is a later enhancement.
4. **Exact additive `llm` config fields** (`model_path`, `engine` knobs) —
   confirm names in §4.4 before schema change.
5. **REST vs CLI emphasis.** Both ship; confirm the REST surface list in §5 is
   the right scope for v2 (vs. CLI-only + REST later). Leaning: ship both, REST
   is thin.
6. **Where the model sits in the sandbox.** Does `llama-server` run *inside* the
   same sandbox as Sandy (its egress is then zero, ideal) or outside? For
   air-gap + least-privilege, **inside** is cleanest; confirm the runtime config
   allows the extra subprocess (the capability manifest already lists
   subprocess needs — `llama-server` joins that list).

## 8. Build order (when approved)

1. **`LlmEngine` local backend** — `LlamaCppEngine` (+ `RemoteEngine` for SD-04)
   behind the existing seam; a `StubEngine` test double; `createLlmEngine` wired
   so `local`/`remote` construct instead of throwing. *Testable with no model.*
2. **Config extension** — additive `llm` fields + fail-closed model-file
   validation.
3. **Autonomous loop** — parse → run → narrate, model output validated against
   the request schema; unit-tested against `StubEngine`.
4. **Local API** — loopback REST over the composed Sandy + `sandy serve`.
5. **Service lifecycle** — graceful shutdown, model health in `check()`.
6. **Conformance for standalone** — run the existing egress + sandbox matrix
   against a standalone config (proves parity/egress hold); add a stub-model
   end-to-end (goal → report) to the CI matrix.

## 9. Conformance & test strategy

- The **stub engine** makes the whole standalone path CI-runnable with no model
  download and no GPU: loop, API, and lifecycle are tested deterministically.
- The **existing egress + sandbox conformance** must pass for a standalone
  config — that is the proof that adding a model didn't break the no-egress /
  cross-sandbox guarantees (SD-05/SD-06 at the security level).
- A **model-quality note** (SD-06) is surfaced to the user at report time
  ("generated by a local model; quality may vary"), per the PRD.

## 10. Non-goals for v2

- Write-back to internal systems (still Q6-deferred; the gate contract exists).
- Extra report formats (HTML/DOCX/XLSX/PDF) — still deferred.
- Recurring report templates (RG-08) — still deferred.
- Multi-turn agentic planning beyond the single gather→report pass.
- Multi-user / network-exposed API (one instance per user, loopback only).

## 11. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Weak 4–8B model produces bad plans | Model output validated against the request schema; deterministic scaffolding carries the report; narrow scope (SD-05) |
| Model/quality variance surprises users | Surface a "local model, quality may vary" note (SD-06); provenance unaffected |
| Model runtime is heavy/fragile | Subprocess isolation (§4.1); model health in `check()`; graceful stop |
| Local API becomes a leak | Loopback-only, refused off-loopback, no non-loopback bind |
| Air-gap: no way to get the model | `model_path` config + team-shipped file (open Q1, leaning docs-based) |
