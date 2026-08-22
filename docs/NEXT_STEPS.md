# Next Steps — Resume Point

_Last updated 2026-08-22. Read this together with `docs/DIARY.md` (chronological log) and `docs/DECISIONS.md` (resolved open questions)._

## Status

**Phase 1 and Phase 2 are both complete, and the real bundled model is proven end-to-end.** The core library is built, tested, composed into a runnable `sandy` binary, wired into a Claude Code / Codex plugin, and the standalone service (bundled-LLM mode) is built, proven with the stub model, **and now proven with a real model** (Qwen3-4B-Instruct-2507 on an RTX 5090) inside a no-egress sandbox (169/169 tests, typecheck + build green). The launch success criterion — "zero network egress outside declared MCP endpoints" — is proven in-process and at the network level in Docker, **and the enforcer is proven runtime-agnostic for BOTH modes**: the same config + request under Docker and Firejail produce byte-identical behavior for **plugin** (host engine, `sandy run`) **and standalone** (bundled model, `sandy ask`) (CI matrix). The host LLM is the engine in plugin mode (PL-03, usage recorded via `sandy.model.usage`); in standalone mode the bundled model is the engine behind the same `LlmEngine` seam.

**The real bundled model is now proven end-to-end (2026-08-22).** The stub-model
conformance had proven the *path*; this session shipped a real model against it:
provisioned llama.cpp (Vulkan build, GPU on the RTX 5090 with no CUDA toolkit) +
Qwen3-4B-Instruct-2507 (Q4_K_M, Apache-2.0, SHA256-pinned) via
`scripts/provision-model.sh`, and ran a real `sandy ask` **inside a no-egress
Firejail jail** — the real model planned (validated against the legal tool
catalog), the MCP tool ran, a provenance-tracked report was written to the
confined dir, the model narrated (clearly labeled, SD-06), token usage was
audited, and the model process was reaped (no orphan). Along the way it fixed a
**real integration bug**: `LlamaCppEngine` discovered the model's port by reading
`child.stdout`, but the real `llama-server` logs the `listening on
http://host:PORT` line to **stderr** — so a real model would have timed out (the
stub wrote to stdout, hiding it). The engine now pipes **and drains both**
streams and matches the listen URL specifically. It also settled the three open
design §7 decisions with code: the documented default model, the docs-based
distribution (out-of-band provisioning, no runtime download), and the §4.5
resource-limit scope (`sandbox.max_cpu_percent` → a real llama.cpp `--threads`
cap via `threadsForCpuPercent`; the hard memory ceiling is the service manager's
cgroup). See `docs/MODEL.md`, `docs/DIARY.md` 2026-08-22 (afternoon), and
`docs/PHASE2_DESIGN.md` §7. **169/169 tests, typecheck + build green.**

**Phase 2 (2026-08-21 → 2026-08-22), design §8 steps 1–6, all done:**
- (1–2) Model backends behind the `LlmEngine` seam — `LlamaCppEngine` (SD-02), `RemoteEngine` (SD-04), `StubEngine` (CI double), the lifecycle contract wired into `Sandy.close()`, additive `llm` config, engine health in `check()`.
- (3) The autonomous reasoning loop (`src/standalone/loop.ts`) — parse (bounded, validated, deterministic fallback) → run → narrate — as `sandy.loop` / `sandy ask`.
- (4) The loopback-only local API (`src/standalone/api.ts`) — plain `node:http` over the composed `Sandy`, bounded job store, serial worker, SSE progress; off-loopback bind refused fail-closed.
- (5) The service lifecycle — `sandy serve` (eager `engine.start()`, graceful SIGINT/SIGTERM shutdown; a dead model is a reported `degraded` state, not a crash).
- (6) Standalone conformance — the egress + sandbox-matrix harnesses parameterized (`SANDY_MODE=standalone`) with a `conformance/stub-model.mjs` loopback stand-in for the model, proving the no-egress / cross-sandbox guarantees hold with the in-sandbox loopback model, byte-identical across Docker + Firejail, in the CI matrix.

See `docs/PHASE2_DESIGN.md` (build order §8 now fully done; open decisions §7) for the full write-up.

Commits so far (oldest → newest):
- `fa61dc5` config layer (Zod schemas + fail-closed loader)
- `a41fb93` Sandbox Enforcer
- `d02371e` MCP Client Manager
- `7e2609a` File Manager
- `42db211` Audit Logger + Orchestrator
- `9da1bd0` CLI / service entry point
- `17cdb8b` Claude Code / Codex plugin (`src/plugin/` + `plugin/`)
- `8dd9c14` egress conformance test: `conformance/` (+ `egress_blocked` audit wiring)
- `c682247` sandbox conformance matrix (Docker + Firejail, CI) + `inFirejail` detection fix
- `c1cfcc7` model-engine seam: `src/engine.ts` (`LlmEngine`/`HostLlmEngine`), `sandy.model.usage` tool (AU-01)
- `76fe24f` engine backends + lifecycle (`LlamaCppEngine`/`RemoteEngine`/`StubEngine`, design §8 steps 1–2)
- `34b966c` autonomous loop: `src/standalone/loop.ts` + `sandy ask` (design §8 step 3)
- `378c963` loopback-only local API + `sandy serve` + service lifecycle: `src/standalone/api.ts` (design §8 steps 4–5)
- (this session) standalone conformance: `conformance/stub-model.mjs` + parameterized harnesses (design §8 step 6)

## What's built (do not rebuild)

| Module | Path | Covers |
|--------|------|--------|
| Config | `src/config/` | `sandy.json` + `mcp-servers.json` schemas, fail-closed loader, env-ref-only secrets, version pins, VPN-02 cross-check |
| Sandbox Enforcer | `src/sandbox/` | runtime detection, real-path path confinement (symlink-escape refusal), capability manifest + reduced-mode report, NetworkGuard egress choke point |
| MCP Client Manager | `src/mcp/` | multi-server lifecycle (stdio/sse/http), startup validation, per-server tool allowlists (pre-wire), retries/backoff, terminal failures, args-by-hash audit; all HTTP through NetworkGuard |
| File Manager | `src/files/` | confined CRUD, confirmation gates, undo journal (+subtree snapshots), dry-run, ignore patterns, format validation (text/csv/json/md) |
| Audit | `src/audit/` | append-only structured log (in-memory + JSONL), opt-in payloads, sink bridges, session transcript export |
| Orchestrator | `src/orchestrator/` | bounded fan-out, provenance claims, explicit gaps, Markdown report renderer, progress events, write-gate contract (ReadOnlyGate); `request.ts` Zod request schema (shared CLI/plugin) |
| Sandy (composition) | `src/sandy.ts` | `createSandy(deps)` startup factory: config → enforcer → audit → MCP → files → orchestrator; `check()` report, `run()`, `close()`. Injectable transport/detection for tests |
| CLI | `src/cli.ts`, `bin/sandy.js` | `sandy check` + `sandy run <request.json>` + `sandy ask "<goal>"` (standalone: model plans → runs → narrates) + `sandy serve` (the long-lived standalone service: eager model start, loopback API, graceful shutdown); `--json`/`--no-progress`/`-c`/`-o`/`--port`; stable exit codes (0 ok / 1 error / 2 usage / 3 config / 4 sandbox) |
| Plugin (host tools) | `src/plugin/` | `tools.ts` (Zod tool-surface contract), `state.ts` (`PluginSession`/`SessionCache`/`ProgressCollector`), `api.ts` (`SandyPluginAPI` — validate → delegate → shape, confirmation flow, structured errors), `mcp-server.ts` (MCP stdio server exposing 10 `sandy.*` tools incl. `sandy.model.usage`). `plugin/.claude-plugin/plugin.json` + `plugin/install.sh` (manual install, Q3) |
| LLM Engine | `src/engine.ts` | The reasoning-layer seam (PRD §7) with a **lifecycle contract** (`start`/`isReady`/`status`/`close` + `record`/`invoke`). `HostLlmEngine` (Phase 1 — the host is the engine, records token usage, never invokes); **`LlamaCppEngine`** (SD-02 local — llama.cpp `llama-server` subprocess on loopback, fail-closed on missing model, port discovery, health probe, usage recorded, crash = `degraded` not a crash); **`RemoteEngine`** (SD-04 — egress-guarded endpoint, bearer via `${ENV_REF}`); **`StubEngine`** (deterministic test/CI double, `fail()` for the dead-model path); `ModelRequest` has structured-output knobs (`responseFormat`/`jsonSchema`); `createLlmEngine` builds all four (fails closed on missing `model_path`/guard) |
| Autonomous Loop | `src/standalone/loop.ts` | The Phase 2 reasoning loop (design §2.1): parse (bounded retry ≤3 with the error fed back, validated against `orchestratorRequestSchema` **and** the legal tool catalog — "the model proposes, the schema disposes") → `Orchestrator.run` (unchanged) → optional narrate (clearly-labeled model summary re-rendered into the report). Deterministic conservative fallback (single named tool) or refuse-and-report with an explicit gap on exhaustion; never unbounded, never invents. Every model call audited (`model_invocation`), each step audited (`standalone_parse`/`standalone_plan`/`standalone_narrate`); a dead model degrades, never crashes; `NoModelEngineError` fails closed against the host engine. Exposed as `Sandy.loop` / `sandy ask "<goal>"`; progress sink is swappable (`getProgressSink`/`setProgressSink`) so a service can redirect per-job progress in-band |
| Local API + Service | `src/standalone/api.ts` | The loopback-only REST API (SD-03, design §5) over the composed `Sandy`: plain `node:http` (no framework), binds `127.0.0.1` only (**off-loopback refused fail-closed**). `GET /health` → `check()`, `POST /run` + `POST /ask` → `202`+id, `GET /jobs/:id` → status/result, `GET /reports` (confined dir), `GET /audit` (transcript, AU-03), SSE `GET /jobs/:id/events` (Q4 progress). **Bounded** job store (`BoundedJobStore`: max pending → `429`, completed retention with oldest-evicted → clean `404`); a **serial** worker redirects the orchestrator's + loop's progress per job (the plugin's `ProgressCollector` pattern) |
| Conformance | `conformance/` | `egress.test.ts` (in-process) + `run-docker.sh`/`ep-server.mjs` (Docker network-level egress) + `sandbox-matrix.sh`/`signature.mjs`/`stdio-server.mjs` (Docker + Firejail runtime-agnosticity matrix, SB-10) + `Dockerfile` (shared image). **Both harnesses are parameterized** (`SANDY_MODE=standalone`) and a `stub-model.mjs` (loopback stand-in for the bundled GGUF, §9) makes `sandy ask` run the full loop under both boundaries with no model/GPU — proving the no-egress / cross-sandbox guarantees hold for **standalone** too (SD-05/06). CI: `.github/workflows/ci.yml` runs a `boundary × mode` (docker/firejail × plugin/standalone) matrix + identity check per mode |

Everything is exported from `src/index.ts`. Tests live in `tests/` (use `tests/helpers/mcp.ts` for in-process MCP servers).

## Remaining work (Phase 2 complete — all §8 steps done)

### 1. CLI / service entry point — DONE (2026-08-18)
Composed the modules into a runnable `sandy` binary (the spine the plugin attaches to). See `docs/DIARY.md` 2026-08-18 for the full write-up. Delivered:
- `src/sandy.ts` — `createSandy(deps)`: config → enforcer → audit → MCP → files → orchestrator. Throws fail-closed on invalid config / unsandboxed / runtime mismatch; a *degraded* sandbox or failed MCP server is reported (via `check()`), not thrown. `check()`, `run()`, `close()`.
- `src/orchestrator/request.ts` — Zod `orchestratorRequestSchema` + `toOrchestratorRequest` (shared wire format for CLI + plugin).
- `src/cli.ts` + `bin/sandy.js` + `bin` in `package.json` — `sandy check`, `sandy run <request.json>`, `--json`/`--no-progress`/`-c`/`-o`; exit codes 0/1/2/3/4. Progress on stderr, results on stdout.
- **Fixed a real leak:** `ManagedServer` now closes the transport on a failed connect (a failed stdio connect was orphaning its child process and hanging the process on exit).
- Verified end-to-end against a real stdio MCP subprocess: `check --json` reports healthy; `run` streams progress, returns a provenance claim, writes the report to the confined `reports/` dir, and persists a JSONL audit.

### 2. Claude Code / Codex plugin (PL-01..PL-04) — DONE (2026-08-18)
The Phase 1 flagship. The host LLM does the reasoning (PL-03); Sandy is exposed as a small set of host-side tools over MCP (registered with the host, PL-02; named "Sandy", PL-04). See `docs/DIARY.md` 2026-08-18 for the full write-up. Delivered:
- `src/plugin/tools.ts` — the tool-surface contract (Zod schemas + result types): `sandy.gather`, `sandy.report`, `sandy.status`, `sandy.files.read|list|write|delete|mkdir|rename`.
- `src/plugin/state.ts` — `PluginSession`/`SessionCache` (one Sandy per config, reused across a host's many tool calls) + `ProgressCollector` (Q4 progress returned in-band).
- `src/plugin/api.ts` — `SandyPluginAPI`: validates each body (field-level `ToolInputError`), delegates to the composed Sandy, shapes results. Confirmation-gated file ops return `needsConfirmation` (never auto-confirm, FM-04); every file op reports errors as a structured result, never throws to the host.
- `src/plugin/mcp-server.ts` — MCP stdio server registering the nine `sandy.*` tools; entry point `node dist/plugin/mcp-server.js <sandy.json>`.
- `plugin/.claude-plugin/plugin.json` + `plugin/install.sh` — manual install per Q3 (no registry); `package.json` `files` ships `dist`/`bin`/`plugin`.
- Verified: real MCP stdio handshake lists all nine tools and `sandy.status` reports healthy; **112/112 tests** (was 105).
- **Open (deferred):** how the host surfaces `ProgressEvent`s in its UI — collected in-band now; a host that only shows final results sees them on the result object.

### 3. Egress conformance test (launch success criterion) — DONE (2026-08-18, Docker)
Proved "zero network egress outside declared MCP endpoints" (SB-09; PRD §11/§12) two ways. See `docs/DIARY.md` 2026-08-18 for the full write-up.
- **In-process** (`conformance/egress.test.ts`, always runs): every dialed URL is the declared endpoint; an undeclared endpoint is refused before the dial; an egress block is recorded as `egress_blocked` (AU-01); a full `createSandy` run keeps all egress on the one endpoint; the loader fails closed on a config-time VPN-02 violation.
- **Network-level, Docker** (`conformance/run-docker.sh` + `Dockerfile`): a Docker `--internal` network gives the sandbox a runtime-enforced zero-external-egress boundary. The declared endpoint is an EP container (logs each hit); asserts `sandy run` succeeds + the EP is hit, an external-egress probe is BLOCKED, and an undeclared endpoint fails closed (VPN-02) with nothing leaving.
- Wired: `npm run conformance` (in-process + Docker). **Firejail** is the same harness with the boundary command swapped (enforcer is runtime-agnostic) — see item 4, since firejail isn't installed in this environment.

### 4. Sandbox conformance (SB-09/10) — DONE (2026-08-20)
Proved the enforcer is runtime-agnostic: the same config + request under Docker and Firejail produce **byte-identical behavior**. See `docs/DIARY.md` 2026-08-20. Delivered:
- **Detection fix (a real bug the matrix surfaced):** real firejail sets `container=firejail` (not `FIREJAIL=1` / `/.firejail`), which the detector missed — so a firejail jail on a Docker host was mis-detected and a `firejail` config was wrongly refused. `inFirejail` now recognizes the real signal and is checked before docker (nested jails report the inner boundary). +4 tests incl. the nested case.
- **`conformance/sandbox-matrix.sh`** — runs the same `sandy check`+`run` under both boundaries (Docker `--network none`, Firejail `--net=none` non-root) and asserts each is healthy + the two boundaries' **behavior signatures are byte-identical**. Modes: `SANDY_MATRIX=docker|firejail` (one leg) or both + cross-check; `SANDY_REQUIRE=1` fails closed on a missing boundary (CI), else it skips.
- **`conformance/signature.mjs`** — the runtime-agnostic projection (capability decision, egress allowlist, MCP fleet, provenance `argsHash`); deliberately excludes runtime-specific fields (detected runtime + evidence, absolute paths, timestamps, durations).
- **`conformance/stdio-server.mjs`** — stdio MCP fixture (no network, so the matrix isolates boundary behavior from egress).
- **`.github/workflows/ci.yml`** — `core` (typecheck/build/test + in-process conformance) → `conformance` matrix (docker + firejail, fail-closed, upload signature) → `identity` (download both, require byte-identical).
- **Scripts:** `npm run conformance` now includes the sandbox matrix; `conformance:sandbox` / `:docker` / `:firejail` for single legs.
- **Verified locally with both boundaries present:** both conform, signatures identical, skip/require paths correct, egress harness still green. **121/121 tests** (was 117).

### 5. Model engine wiring — DONE for Phase 1 (plugin mode), 2026-08-20
- **Plugin mode (delivered):** the host LLM is the engine (PL-03). `src/engine.ts` defines the `LlmEngine` seam (PRD §7 "LLM Engine"): `record()` writes a `model_invocation` audit event with token counts (AU-01) and `invoke()` is the model-call point. `HostLlmEngine` is the Phase 1 impl — it records host-reported usage and throws a clear error if asked to `invoke()` (the host reasons outside Sandy). The host feeds its usage via the new **`sandy.model.usage`** tool (10th host tool). The `LlmEngine` interface is the fixed seam a Phase 2 model drops in behind; `createLlmEngine` **fails closed** for `local`/`remote` (SD-02/04, Phase 2) until they're built.
- **Standalone mode (Phase 2, still deferred):** bundle a 4–8B model behind `LlmEngine.invoke()` (SD-02/04). Out of scope for Phase 1.

### 6. Phase 2 — engine backends behind the `LlmEngine` seam (SD-02/04) — DONE (2026-08-21)
Design `docs/PHASE2_DESIGN.md` §8 build order **steps 1–2**, plus the `check()`/`close()` plumbing step 5 needs early. See `docs/DIARY.md` 2026-08-21 for the full write-up. Delivered:
- **`LlmEngine` lifecycle** (`start`/`isReady`/`status`/`close`) — the review finding from the design revision; `Sandy.close()` now reaps the model backend first (never orphaned), and `SandyCheckReport.engine` carries health (a `degraded` engine flips `ok:false`, a reported state not a crash).
- **`LlamaCppEngine`** (SD-02): llama.cpp `llama-server` as a subprocess on a **loopback** port — in-sandbox, zero-egress by construction. Fail-closed on a missing model file, port discovery, `/health` readiness probe, token usage recorded (AU-01), a crash = `degraded` state. Injectable spawn/fetch/now for tests.
- **`RemoteEngine`** (SD-04): same interface, no child process; the endpoint is checked against the `NetworkGuard` **before any dial** (VPN-02), bearer token from `${ENV_REF}` at point of use.
- **`StubEngine`**: deterministic in-process double — this is what makes the standalone loop/API/lifecycle CI-runnable with **no model and no GPU** (design §9).
- **Config extension** (§4.4, additive): `llm.model_path` (absolute) + `llm.engine` (`type`/`command`/`host`/`port`); `host` constrained to loopback; `local` now requires `model` + `model_path`.
- `createLlmEngine` builds `local`/`remote` instead of throwing; `ModelRequest` gained the structured-output knobs (`responseFormat: "json"` / `jsonSchema`) the parse step needs (design open #6, leaning (a)+(b), now wired at the seam level).
- **138/138 tests** (was 126, +12), typecheck + build green. The whole standalone path is testable with no model present.

### 7. Phase 2 — steps 3–6 (loop, local API, service, conformance) — DONE (2026-08-22)
The rest of the standalone service, all committed and proven. See `docs/DIARY.md` 2026-08-22 for the full write-up.
- **(3) Autonomous loop** (`src/standalone/loop.ts`): parse (bounded ≤3, validated against the request schema **and** the legal tool catalog) → run (unchanged orchestrator) → narrate (clearly-labeled, re-rendered into the report); deterministic conservative fallback or refuse-and-report on exhaustion; a dead model degrades, never crashes; `NoModelEngineError` fails closed against the host engine. `sandy.loop` / `sandy ask "<goal>"`.
- **(4) Loopback-only local API** (`src/standalone/api.ts`): plain `node:http` over the composed `Sandy`, off-loopback bind refused fail-closed; `GET /health`/`/reports`/`/audit`, `POST /run`+`/ask` → `202`+id, `GET /jobs/:id`, SSE `GET /jobs/:id/events`; a **bounded** job store (max pending → `429`, completed retention with oldest-evicted → clean `404`) and a **serial** worker that redirects per-job progress in-band.
- **(5) Service lifecycle** (`sandy serve`): eager `engine.start()`, long-lived until SIGINT/SIGTERM, graceful shutdown (API → in-flight job → `engine.close()` → MCP → audit flush); a dead model is a reported `degraded` state, not a crash.
- **(6) Standalone conformance:** the egress + sandbox-matrix harnesses gain a `SANDY_MODE=standalone` switch and a new `conformance/stub-model.mjs` (a loopback OpenAI-compatible stand-in for the bundled GGUF, design §9), so `sandy ask` runs the full loop under both boundaries with no real model, no GPU, and no external egress. **Proven byte-identical across Docker + Firejail for both modes**, and the egress harness's three assertions (EP hit / external blocked / undeclared fails closed) hold with the in-sandbox model present. The always-running in-process egress gate also gained a model-present standalone leg (`conformance/egress.test.ts`): a `standalone` config + injected model engine runs the full `ask` loop and every dialed URL is the one declared endpoint. The CI matrix now runs both modes (4 legs) and proves each byte-identical. **164/164 tests**, typecheck + build green.

### Explicitly deferred (later, per DECISIONS.md + PRD §10)
- Extra report formats (HTML/DOCX/XLSX/PDF)
- Recurring report templates (RG-08)
- Write-back implementation (Q6 — the gate contract already exists; implementing it needs the admin write allowlist + an approval UI/flow)
- Dry-run/undo are done; multi-root is done

_(Concrete "where to start" for each deferred item is in the "Pick one" section below, near the bottom. The deferred list above is the canonical scope list; the bottom section is the actionable resume pointer.)_

## Conventions to keep
- **Fail closed** everywhere; never smooth over a gap; policy > preferences (tighten-never-loosen).
- Secrets only as `${ENV_REF}`; resolve at point of use, never store/log; args logged by hash only (AU-02).
- No network outside the declared MCP allowlist — everything goes through `NetworkGuard`.
- TypeScript strict, ESM, Node ≥ 22. **Pin `typescript@5.9`** (7.x native compiler has a `@types/node` auto-include bug — see diary 2026-08-17 afternoon).
- Run `npm run typecheck && npm test` after changes; `npm run build` for dist.
- Update `docs/DIARY.md` per work block; keep `README.md` Status section current.

## Suggested first action for the next session
**Phase 1, Phase 2, and the real-model end-to-end are all complete** (design §8 steps 1–6 done, the design §7 decisions settled with code, 169/169 tests, typecheck + build green, the no-egress / cross-sandbox conformance proven for both plugin and standalone modes, **and a real bundled model proven inside a no-egress sandbox**). Read `docs/PHASE2_DESIGN.md` (now fully implemented + §7 settled), `docs/MODEL.md` (provisioning + the default model), and `docs/DIARY.md` 2026-08-22 (afternoon) for the full write-up. **Nothing is blocking.** Pick one of the items below — each has a concrete "where to start."

### Pick one (deferred product items, per DECISIONS.md / PRD §10)

Each of these is a self-contained slice; do the smallest that adds value.

1. **Extra report formats (HTML/DOCX/XLSX/PDF) — easiest first win.**
   - Today the report is Markdown-only: `renderMarkdownReport` in `src/orchestrator/report.ts:19`. The config already declares `preferences.default_report_format` (`markdown|html|docx|xlsx|pdf`) in `src/config/schema.ts`, so the knob exists but is unimplemented.
   - **Where to start:** add a `renderReport(format, input)` dispatcher next to `renderMarkdownReport`; keep the Markdown renderer as the source of truth (HTML can be a lightweight transform; DOCX/XLSX/PDF are higher effort — HTML first). The claims/gaps/provenance table is already structured (`OrchestratorResult`), so a format is a view over it, not new logic. Wire the chosen `format` through the orchestrator's report write (`src/orchestrator/factory.ts`) and the File Manager write (`.md` extension already assumed — generalize the extension per format). Add a test per format asserting the same claims/provenance survive the transform.
   - **Keep:** fail-closed (an unimplemented format is a config error, not a silent Markdown fallback); provenance/claims identical across formats (SD-06 — the *content* must not change, only the presentation).

2. **Recurring report templates (RG-08).**
   - PRD §10 / line 109: "a saved request that can be re-run on a schedule or on demand against fresh data."
   - **Where to start:** a template is exactly an `orchestratorRequestSchema` object (the same shape `sandy run <request.json>` and `POST /run` take). So v1 = a small registry of named saved requests + a verb/API to run one: `sandy run <template-name>` and `POST /run {template}`. The loop/API/orchestrator are unchanged — a template just resolves to a request. "On a schedule" is the supervisor's job (the service is designed to be launched by systemd/launchd, design §6); v1 does **on-demand re-run**, not a cron.
   - **Keep:** a template is validated by the *same* `orchestratorRequestSchema` + legal tool catalog as an ad-hoc request (nothing new is legal because it's "saved").

3. **Write-back (Q6 — the biggest, most design-heavy).**
   - The **gate contract already exists**: `WriteApprovalGate` / `ReadOnlyGate` in `src/orchestrator/write-gate.ts` (decides allow/refuse from policy + an approval, pure + auditable). `src/files/journal.ts` marks the hook point ("an operation only reaches [the filesystem] [after the gate]").
   - **Where to start:** this needs two things that don't exist yet — (a) an **admin write allowlist** (separate from, and stricter than, the read allowlist; CP-02 policy > preferences) in the config schema, and (b) an **approval flow/UI** (the approval is an auditable event; the plugin's `needsConfirmation` pattern in `src/plugin/api.ts` is the in-band precedent). A non-`ReadOnlyGate` implementation of `WriteApprovalGate` + the allowlist config is the core; the approval UX is the surface. This is the one item that materially widens the security surface, so go slow and keep fail-closed (default `ReadOnlyGate` = refuse all writes).
   - **Keep:** never auto-confirm (FM-04 precedent); a write is a distinct audited event; the read allowlist is untouched.

### Optional hardening (nice-to-have, not product scope)
- **`SANDY_REAL_MODEL` conformance leg:** add an opt-in leg to `conformance/sandbox-matrix.sh` that runs `sandy ask` against a real GGUF when one is provisioned (the stub-model leg already runs in CI; the real model was proven manually — see DIARY 2026-08-22 afternoon). Guard it so CI stays green with no model (skip unless `SANDY_REAL_MODEL` is set + the file exists).
- **In-service hard memory bound:** the hard ceiling is currently the service manager's cgroup (`memory.max`/`--memory`/`MemoryMax=`). If the team wants the ceiling in-process, wrap the model's process group in a cgroup — a small, flagged addition (§4.5).
- **Multi-turn / agentic planning:** extend the single gather→report pass in `src/standalone/loop.ts:178` (`run(goal)`) to plan a second round from the first results. A design §10 non-goal for v2; the validate-then-run seam is what it extends.
