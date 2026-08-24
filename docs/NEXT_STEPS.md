# Next Steps — Resume Point

_Last updated 2026-08-24. Forward-looking only: the current state, what's built (so it isn't rebuilt), and what's next. The chronological account of how things got here is `docs/DIARY.md` (append-only) — **do not restate milestones here, point at the DIARY**. Resolved open questions: `docs/DECISIONS.md`. Design decisions: `docs/PHASE2_DESIGN.md` and `docs/MODEL.md`. Commit history: `git log`._

## Status

**v0.1.1 (2026-08-23). Phase 1 and Phase 2 complete; the real bundled model is proven end-to-end.**

- **195/195 tests**, typecheck + build green.
- The launch success criterion — "zero network egress outside declared MCP endpoints" — is proven in-process and at the network level in Docker, and the enforcer is proven runtime-agnostic for **both** modes: the same config + request under Docker and Firejail produce byte-identical behavior for plugin (`sandy run`) and standalone (`sandy ask`), in a CI matrix.
- A **real** bundled model (Qwen3-4B-Instruct-2507, Vulkan/GPU, SHA256-pinned) ran the full `sandy ask` loop inside a no-egress sandbox: planned (validated against the policy's legal tool catalog) → MCP tool ran → provenance-tracked report written → model narrated (clearly labeled, SD-06) → usage audited → model process reaped (no orphan). That session also fixed a real integration bug the stub had hidden (`LlamaCppEngine` port discovery had to read **stderr**, where the real `llama-server` logs its listen URL). See `docs/MODEL.md` and `docs/DIARY.md` 2026-08-22 (afternoon).
- The 2026-08-22 full-repo review (`reviews/2026-08-22-full-repo-review.md`) is closed: 7 security findings fixed and released in **v0.1.1** (7 private advisories, all `patched_versions: 0.1.1`), plus 12 follow-up fix PRs (PRs #20–#37) merged. See `docs/DIARY.md` 2026-08-23.

**Nothing is blocking.** The remaining work is the deferred product scope (below), all tracked as GitHub issues.

## What's built (do not rebuild)

| Module | Path | Covers |
|--------|------|--------|
| Config | `src/config/` | `sandy.json` + `mcp-servers.json` schemas, fail-closed loader, env-ref-only secrets, version pins, VPN-02 cross-check (default-port endpoints normalized via the shared `endpointOf`) |
| Sandbox Enforcer | `src/sandbox/` | runtime detection, real-path path confinement (symlink-escape refusal), capability manifest + reduced-mode report, NetworkGuard egress choke point |
| MCP Client Manager | `src/mcp/` | multi-server lifecycle (stdio/sse/http), startup validation, per-server tool allowlists (pre-wire), retries/backoff, terminal failures, args-by-hash audit; oauth/mtls fail closed (not yet implemented, refuse unauthenticated connects); all HTTP through NetworkGuard |
| File Manager | `src/files/` | confined CRUD, confirmation gates (incl. rename-onto-existing overwrite gate), undo journal (+subtree snapshots, re-resolved through confinement on undo, byte-exact binary restore), dry-run, ignore patterns (list checks against the confinement root), format validation (text/csv/json/md); mutations + undo audited |
| Audit | `src/audit/` | append-only structured log (in-memory + JSONL, write failures surfaced), opt-in payloads, sink bridges, session transcript export |
| Orchestrator | `src/orchestrator/` | bounded fan-out, provenance claims, explicit gaps, Markdown report renderer, progress events, write-gate contract (ReadOnlyGate); report-write failure is a surfaced `reportError`, claims/gaps never discarded; `request.ts` Zod request schema (shared CLI/plugin) |
| Sandy (composition) | `src/sandy.ts` | `createSandy(deps)` startup factory: config → enforcer → audit → engine → MCP → files → orchestrator; `check()` report (incl. engine health), `run()`, `ask()`, `close()` (reaps the model first). Injectable transport/detection for tests (no production-reachable override) |
| CLI | `src/cli.ts`, `bin/sandy.js` | `sandy check` + `sandy run <request.json>` + `sandy ask "<goal>"` (standalone: model plans → runs → narrates) + `sandy serve` (the long-lived standalone service: eager model start, loopback API, graceful shutdown); `--json`/`--no-progress`/`-c`/`-o`/`--port`; stable exit codes (0 ok / 1 error / 2 usage / 3 config / 4 sandbox) |
| Plugin (host tools) | `src/plugin/` | `tools.ts` (Zod tool-surface contract), `state.ts` (`PluginSession`/`SessionCache` — in-flight promise reserved synchronously, no double-build race —/`ProgressCollector`), `api.ts` (`SandyPluginAPI` — validate → delegate → shape, confirmation flow, structured errors), `mcp-server.ts` (MCP stdio server exposing 10 `sandy.*` tools incl. `sandy.model.usage`). `plugin/.claude-plugin/plugin.json` + `plugin/install.sh` (manual install, Q3) |
| LLM Engine | `src/engine.ts` | The reasoning-layer seam (PRD §7) with a **lifecycle contract** (`start`/`isReady`/`status`/`close` + `record`/`invoke`). `HostLlmEngine` (plugin mode — the host is the engine, records token usage, never invokes); **`LlamaCppEngine`** (SD-02 local — `llama-server` subprocess on loopback, fail-closed on missing model, port discovery from the listen URL on **either** stream, child killed on a failed invocation, `--threads` budget from `sandbox.max_cpu_percent`); **`RemoteEngine`** (SD-04 — egress-guarded endpoint, bearer via `${ENV_REF}`); **`StubEngine`** (deterministic test/CI double, `fail()` for the dead-model path); `ModelRequest` has structured-output knobs (`responseFormat`/`jsonSchema`); `createLlmEngine` builds all four (fails closed on missing `model_path`/guard) |
| Autonomous Loop | `src/standalone/loop.ts` | The Phase 2 reasoning loop (design §2.1): parse (bounded retry ≤3 with the error fed back, validated against `orchestratorRequestSchema` **and** the legal tool catalog — "the model proposes, the schema disposes") → `Orchestrator.run` (unchanged) → optional narrate (clearly-labeled model summary re-rendered into the report; the prompt-injection threat model for narrate is documented in `docs/DECISIONS.md`). Deterministic conservative fallback (single named tool) or refuse-and-report with an explicit gap on exhaustion; never unbounded, never invents. Every model call audited (`model_invocation`), each step audited (`standalone_parse`/`standalone_plan`/`standalone_narrate`); a dead model degrades, never crashes; `NoModelEngineError` fails closed against the host engine. Exposed as `Sandy.loop` / `sandy ask "<goal>"`; progress sink is swappable (`getProgressSink`/`setProgressSink`) so a service can redirect per-job progress in-band |
| Local API + Service | `src/standalone/api.ts` | The loopback-only REST API (SD-03, design §5) over the composed `Sandy`: plain `node:http` (no framework), binds `127.0.0.1` only (**off-loopback refused fail-closed**). `GET /health` → `check()`, `POST /run` + `POST /ask` → `202`+id, `GET /jobs/:id` → status/result, `GET /reports` (confined dir), `GET /audit` (transcript, AU-03), SSE `GET /jobs/:id/events` (Q4 progress). **Bounded** job store (`BoundedJobStore`: max pending → `429`, completed retention with oldest-evicted → clean `404`); a **serial** worker redirects the orchestrator's + loop's progress per job. **CSRF-hardened:** non-`application/json` Content-Type → `415`; foreign `Origin` → `403` (independent of CORS). The idle worker waits on an event-driven wake, not a busy-poll |
| Conformance | `conformance/` | `egress.test.ts` (in-process, incl. a model-present standalone leg) + `run-docker.sh`/`ep-server.mjs` (Docker network-level egress) + `sandbox-matrix.sh`/`signature.mjs`/`stdio-server.mjs` (Docker + Firejail runtime-agnosticity matrix, SB-10) + `Dockerfile` (shared image) + `stub-model.mjs` (loopback stand-in for the bundled GGUF, design §9). **Both harnesses are parameterized** (`SANDY_MODE=standalone`), proving the no-egress / cross-sandbox guarantees hold for **both** modes (SD-05/06). CI: `.github/workflows/ci.yml` runs a `boundary × mode` (docker/firejail × plugin/standalone) matrix + byte-identical-signature identity check per mode |
| Model provisioning | `scripts/provision-model.sh`, `docs/MODEL.md` | Install-time, out-of-band: installs `llama-server` (Vulkan build) + the documented default model (Qwen3-4B-Instruct-2507 Q4_K_M, Apache-2.0), **both SHA256-pinned, fail-closed on mismatch** (the binary is verified before extraction; an override without an explicit hash fails closed), then prints the ready-to-paste `llm` block. The runtime itself never downloads a model |

Everything is exported from `src/index.ts`. Tests live in `tests/` (use `tests/helpers/mcp.ts` for in-process MCP servers).

## Remaining work (Phase 1 + Phase 2 complete — all §8 steps done)

Everything that was in the original remaining-work list (CLI, plugin, egress conformance, sandbox conformance, engine seam, backends, loop, API, service, standalone conformance, real-model end-to-end) is **done and released in v0.1.1** — the write-ups are in `docs/DIARY.md`. What remains is the deferred product scope (per `docs/DECISIONS.md` + PRD §10) and optional hardening. Each is a tracked GitHub issue; the "where to start" notes below are the actionable substance.

### Deferred product items

1. **Extra report formats (HTML/DOCX/XLSX/PDF) — issue #14 — easiest first win.**
   - Today the report is Markdown-only: `renderMarkdownReport` in `src/orchestrator/report.ts:19`. The config already declares `preferences.default_report_format` (`markdown|html|docx|xlsx|pdf`) in `src/config/schema.ts`, so the knob exists but is unimplemented.
   - **Where to start:** add a `renderReport(format, input)` dispatcher next to `renderMarkdownReport`; keep the Markdown renderer as the source of truth (HTML can be a lightweight transform; DOCX/XLSX/PDF are higher effort — HTML first). The claims/gaps/provenance table is already structured (`OrchestratorResult`), so a format is a view over it, not new logic. Wire the chosen `format` through the orchestrator's report write (`src/orchestrator/factory.ts`) and the File Manager write (`.md` extension already assumed — generalize the extension per format). Add a test per format asserting the same claims/provenance survive the transform.
   - **Keep:** fail-closed (an unimplemented format is a config error, not a silent Markdown fallback); provenance/claims identical across formats (SD-06 — the *content* must not change, only the presentation).

2. **Recurring report templates (RG-08) — issue #15.**
   - PRD §10: "a saved request that can be re-run on a schedule or on demand against fresh data."
   - **Where to start:** a template is exactly an `orchestratorRequestSchema` object (the same shape `sandy run <request.json>` and `POST /run` take). So v1 = a small registry of named saved requests + a verb/API to run one: `sandy run <template-name>` and `POST /run {template}`. The loop/API/orchestrator are unchanged — a template just resolves to a request. "On a schedule" is the supervisor's job (the service is designed to be launched by systemd/launchd, design §6); v1 does **on-demand re-run**, not a cron.
   - **Keep:** a template is validated by the *same* `orchestratorRequestSchema` + legal tool catalog as an ad-hoc request (nothing new is legal because it's "saved").

3. **Write-back (Q6 — the biggest, most design-heavy) — issue #16.**
   - The **gate contract already exists**: `WriteApprovalGate` / `ReadOnlyGate` in `src/orchestrator/write-gate.ts` (decides allow/refuse from policy + an approval, pure + auditable). `src/files/journal.ts` marks the hook point ("an operation only reaches [the filesystem] [after the gate]").
   - **Where to start:** this needs two things that don't exist yet — (a) an **admin write allowlist** (separate from, and stricter than, the read allowlist; CP-02 policy > preferences) in the config schema, and (b) an **approval flow/UI** (the approval is an auditable event; the plugin's `needsConfirmation` pattern in `src/plugin/api.ts` is the in-band precedent). A non-`ReadOnlyGate` implementation of `WriteApprovalGate` + the allowlist config is the core; the approval UX is the surface. This is the one item that materially widens the security surface, so go slow and keep fail-closed (default `ReadOnlyGate` = refuse all writes).
   - **Keep:** never auto-confirm (FM-04 precedent); a write is a distinct audited event; the read allowlist is untouched.

### Optional hardening (nice-to-have, not product scope)

- **`SANDY_REAL_MODEL` conformance leg — issue #17:** add an opt-in leg to `conformance/sandbox-matrix.sh` that runs `sandy ask` against a real GGUF when one is provisioned (the stub-model leg already runs in CI; the real model was proven manually — see DIARY 2026-08-22 afternoon). Guard it so CI stays green with no model (skip unless `SANDY_REAL_MODEL` is set + the file exists).
- **In-service hard memory bound — issue #18:** the hard ceiling is currently the service manager's cgroup (`memory.max`/`--memory`/`MemoryMax=`). If the team wants the ceiling in-process, wrap the model's process group in a cgroup — a small, flagged addition (§4.5).
- **Multi-turn / agentic planning — issue #19:** extend the single gather→report pass in `src/standalone/loop.ts` (`run(goal)`) to plan a second round from the first results. A design §10 non-goal for v2; the validate-then-run seam is what it extends.

## Conventions to keep
- **Fail closed** everywhere; never smooth over a gap; policy > preferences (tighten-never-loosen).
- Secrets only as `${ENV_REF}`; resolve at point of use, never store/log; args logged by hash only (AU-02).
- No network outside the declared MCP allowlist — everything goes through `NetworkGuard`.
- TypeScript strict, ESM, Node ≥ 22. **Pin `typescript@5.9`** (7.x native compiler has a `@types/node` auto-include bug — see DIARY 2026-08-17 afternoon).
- Run `npm run typecheck && npm test` after changes; `npm run build` for dist.
- Update `docs/DIARY.md` per work block; keep `README.md`'s Status section current. **Doc roles (per issue #13):** DIARY = chronological history (append-only), NEXT_STEPS = forward-looking state + this roadmap, README = short headline status + links. Don't restate a milestone in more than one of them.

## Suggested first action for the next session

**Nothing is blocking.** The deferred items above are self-contained slices (now issues #14–#19); do the smallest that adds value — **#14 (extra report formats, HTML first) is the easiest win**, with the concrete "where to start" above. Read `docs/PHASE2_DESIGN.md` (fully implemented, §7 settled), `docs/MODEL.md` (provisioning + the default model), and the tail of `docs/DIARY.md` for the full write-ups.
