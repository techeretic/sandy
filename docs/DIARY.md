# Work Diary

## 2026-08-17

- Pulled latest from `origin/master` (f1cafbd → 28d02ba; only change was README.md).
- Reviewed `README.md` and `docs/PRD_Final.md` (authoritative PRD; merged from PRD.md + PRD_Claude.md).
- Confirmed project scope: Sandy — a sandboxable AI assistant that lives inside a user-defined sandbox, talks to internal services exclusively via MCP servers, and produces provenance-tracked reports. Phase 1 = Claude Code / Codex plugin (read-and-report only). Phase 2 = standalone service with bundled 4–8B LLM for air-gapped use.
- Agreed next steps (planning → build):
  1. Resolve PRD §13 open questions.
  2. Write a design/ADR doc capturing those decisions.
  3. Define config schemas (`sandy.json`, `mcp-servers.json`) as the contract first.
  4. Build Phase 1 in dependency order: Sandbox Enforcer → MCP Client Manager → File Manager → Orchestrator + audit logging → Claude Code / Codex plugin interface.
  5. Stand up egress conformance test (zero traffic outside declared MCP endpoints) in ≥2 sandboxes (Docker + Firejail).
- Resolved all 9 open questions from PRD §13 (see `docs/DECISIONS.md`):
  1. Sandboxes: Docker + Firejail at launch; enforcer stays runtime-agnostic.
  2. Stack: TypeScript/Node.
  3. Distribution: git repo + manual install.
  4. Streaming: yes, stream progress in v1.
  5. Multi-user: one instance per user.
  6. Write-back: defer implementation, design approval-gate architecture now.
  7. MCP versioning: pin in `mcp-servers.json`, VCS-reviewed.
  8. Long-running tasks: session-scoped only in v1.
  9. MCP authoring: include scaffolding tools.
- Next: scaffold the repo — config schemas (`sandy.json`, `mcp-servers.json`) first.

### 2026-08-17 (afternoon) — Repo scaffold + config layer

- Initialized TypeScript/Node repo (ESM, strict, Node 22). Scripts: `build`, `typecheck`, `test`.
- **Pinned TypeScript to 5.9.x.** `npm i typescript` pulled 7.0.2 (the new native Go compiler, `tsgo`), which fails to auto-include `@types/node` for in-project files (TS2591 on `node:*` imports) unless `types: ["node"]` is set explicitly. Known-bad for v1; revisit once 7.x stabilizes.
- Implemented `src/config/schema.ts`:
  - `envRefSchema` — secrets only as `${VAR}` refs (MCP-08); literal values rejected
  - `absolutePathSchema` — no `..` traversal (SB-06)
  - `endpointSchema` — hostname[:port] allowlist entries (VPN-02)
  - `semverPinSchema` — exact version pins only (Q7)
  - MCP server manifest: discriminated union stdio/sse/http, per-server `allowed_tools` ⊆ `capabilities` (MCP-07), unique names, strict objects
  - Policy: `confirmation_required` must always include `delete` + `overwrite` (FM-04 floor — users can tighten, never loosen)
- Implemented `src/config/loader.ts` (CP-04 fail-closed):
  - Validates both files, clear per-field errors
  - Cross-checks remote MCP endpoints against `sandbox.allowed_network` (VPN-02)
  - Pre-flight check that every referenced env var exists; refuses to start if not
  - `SecretResolver` keeps secrets out of the parsed config object — values only at point of use
- Example configs in `config/` (plugin mode, docker, crm stdio + jira sse).
- `tests/config.test.ts`: 13 tests, all pass — covers valid load, no secret leakage into config, literal-secret rejection, missing env fail-closed, strict unknown fields, `..` path rejection, tool-allowlist ⊆ capabilities, duplicate names, range-version rejection, VPN-02 egress violation, FM-04 floor, malformed JSON, missing manifest.
- Smoke-tested: built + loaded example configs through the real loader. Green.
- Next: Sandbox Enforcer (SB-03/04/06) for Docker + Firejail.

### 2026-08-17 (evening) — Sandbox Enforcer

- Committed the config layer as `fa61dc5` and pushed.
- Built `src/sandbox/` — four modules + facade:
  - **`detect.ts`** (SB-03): runtime detection for gVisor, Firejail, Docker/K8s-pod, WSL, with evidence strings. Detection context is injectable for tests.
  - **`confinement.ts`** (SB-06): `PathConfinement` — every path must pass `resolve()`. Rejects null bytes, `..` traversal lexically, and — the important part — **symlink escapes**: resolves the deepest existing prefix via realpath and requires the real result to be inside a declared root. Missing containing root = fail-closed `root-missing`.
  - **`capabilities.ts`** (SB-04/05): declarative `CapabilityManifest` (filesystem roots, network endpoints, subprocess needs) + `probeCapabilities` → explicit `CapabilityReport` with `lost[]` entries; Sandy starts in **reduced mode and reports what it lost** rather than failing opaquely. No runtime capability escalation (SB-05).
  - **`network.ts`** (SB-07/VPN-02): `NetworkGuard` — the single choke point the MCP transport layer must call before any dial. http(s) only, endpoint must be in the declared allowlist, case-insensitive hostnames, port-sensitive.
  - **`enforcer.ts`**: `SandboxEnforcer.create()` facade — refuses to start with no detected boundary (unless `runtime: "custom"`), fails closed on declared-vs-detected runtime mismatch (docker→k8s-pod compatible).
- **Security note:** first draft of `confinement.ts` had a real hole — with a missing root, the walk-up loop climbed to an existing ancestor (/tmp) and reconstructed the tail, so `resolve()` "succeeded" outside the root. Fixed by requiring the containing root to exist before walking. Caught by the test suite.
- `tests/sandbox.test.ts`: 29 new tests (detection matrix, `..`/absolute/null-byte/symlink escapes, multi-root, missing root, NetworkGuard matrix, enforcer mismatch/reduced-mode). **42/42 pass**, typecheck + build green.
- Committed as `a41fb93` and pushed.

### 2026-08-17 (night) — MCP Client Manager

- Added `@modelcontextprotocol/sdk` (client + server + in-memory transport). Verified the real API surface before coding (Client/`callTool`/`listTools`, `StdioClientTransport`, `SSEClientTransport`, `StreamableHTTPClientTransport`, `InMemoryTransport.createLinkedPair`, `McpServer.registerTool`, `FetchLike`).
- Built `src/mcp/`:
  - **`types.ts`**: health states (disconnected/connected/degraded/unreachable — MCP-09), `McpCallRecord` (args by sha256 hash only — AU-02), `McpAuditSink` interface (MCP-12), `McpCallError` with failure reasons + retryable flag, `RetryPolicy`.
  - **`retry.ts`**: `withRetry` — exponential backoff, capped, only retries failures classified as transient (MCP-11). Injectable sleep for tests.
  - **`transports.ts`**: `createTransport` (stdio/sse/streamable-http; bearer/api-key auth resolved from `SecretResolver` at construction — never stored; stdio env from env refs) and `guardedFetch` — wraps the SDK's `fetch` option so **every HTTP request passes the NetworkGuard** (SB-07/VPN-02 at the socket layer, not just config time). OAuth/mtls noted as Phase 1 follow-up.
  - **`managed-server.ts`**: `ManagedServer` — connect + validate (MCP-03: allowed tools cross-checked against the server's actual `tools/list`; missing tools ⇒ degraded, said out loud), `callTool` with per-server allowlist enforced **before anything hits the wire** (MCP-07), retry classification (transport/timeout = retryable; `McpError` and `isError` tool results = protocol, never retried), audit per call.
  - **`manager.ts`**: `McpClientManager` — parallel `connectAll` (MCP-04), startup failure is **terminal and explicit** (MCP-10): failed servers are dropped from the callable set and reported so reports must surface them as gaps (RG-05); `health()` summary (MCP-09); `close()` idempotent.
- SDK/TS gotchas hit and resolved: `Required<>` on an interface with optional members; SDK `FetchLike` is `(string|URL, RequestInit) => Promise<Response>` (no `RequestInfo` in our lib target); Zod 4 `z.record()` needs two args; `registerTool` without `inputSchema` makes the callback receive only `extra` (so the test server needed an explicit permissive schema to echo args); tool callback exceptions surface as `isError:true` results, not thrown errors — handled in `callTool`.
- `tests/mcp.test.ts`: 13 new tests using real in-process `McpServer`s over `InMemoryTransport`, plus a `FlakyTransport` decorator (fails first N `tools/call` sends) for retry coverage, and a recording audit sink. **55/55 pass**, typecheck + build green.
- Committed as `d02371e` and pushed.

### 2026-08-17 (late night) — File Manager

- Built `src/files/` — four modules:
  - **`ignore.ts`** (FM-07): gitignore-lite matcher. A bare name (`node_modules`, `.git`) matches any path segment; `*`/`?` globs match per segment. If any segment matches, the path is ignored — which transitively covers "everything under an ignored dir".
  - **`format.ts`** (FM-08): extension → format detection (text/markdown/csv/json, default text) + content validation. JSON must parse; CSV must have a consistent field count per row (quote-aware).
  - **`journal.ts`** (FM-05, design-now per Q6): `MutationJournal` interface + `InMemoryJournal`. Every mutation journaled with before/after state; undo of the last N in reverse order. Deleted directories are snapshotted as a full subtree so undo restores them. The reversal function is injected, so a durable backend drops in behind the same interface. This is also the seam the write-approval gate (Q6) will hook into: ops only reach the journal after passing confirmation.
  - **`file-manager.ts`** (FM-01..08): `FileManager` over `PathConfinement`. File CRUD + directory create/rename/delete; confirmation gates (delete/overwrite/rename/create — FM-04, tighten-never-loosen floor already enforced at config load); dry-run mode (FM-06); ignore rules applied on read, list (skipped AND never traversed), and every mutation (FM-07); format validation on write (FM-08).
- Design call: `createDirectory` does NOT create parent directories implicitly (least privilege) — the caller creates each level; missing parent ⇒ explicit `not-found` with the missing path named.
- `tests/files.test.ts`: 22 new tests — CRUD, confinement rejections (outside root, `..`), confirmation floors (overwrite/delete/create-strict), dry-run no-ops, directory ops + rename-outside-sandbox + rename-into-ignored, ignore-pattern matrix, format validation (bad JSON/CSV rejected, good accepted), undo journal (LIFO order, directory subtree restore, undo_depth cap, rename reversal). **77/77 pass**, typecheck + build green.
- Committed as `7e2609a` and pushed.

### 2026-08-17 (very late) — Audit Logger + Orchestrator

- Extracted the in-memory MCP server + `serverConfig` + `instantRetry` into a shared `tests/helpers/mcp.ts` (superset: tools can now carry a custom `respond`), and pointed `tests/mcp.test.ts` at it. 77/77 still green.
- Built `src/audit/`:
  - **`logger.ts`** (AU-01/02): `AuditLogger` interface with a fixed event taxonomy (mcp_call, file_mutation, model_invocation, orchestrator_task, write_attempt, sandbox_violation, egress_blocked, session_start/end). `InMemoryAuditLogger` (reference/test) and `JsonlAuditLogger` (append-only, one-object-per-line, ordered, keeps an in-memory mirror so transcript export works). Payload logging is centralized in `append()` and opt-in — no caller can leak a payload past policy (AU-02). Bridges `mcpAuditSink`/`fileAuditSink` adapt the existing component sink interfaces onto the unified log; `logModelInvocation` records token counts.
  - **`transcript.ts`** (AU-03): `captureTranscript` + JSON/Markdown serialization — the "how was this report produced" record, exportable to accompany a report.
- Built `src/orchestrator/`:
  - **`orchestrator.ts`** (RG-01/04/05/06, Q4): `Orchestrator.run()` fans out `GatherTask`s across servers with a bounded worker pool (concurrency, default 5). Each successful call → provenance-tagged `Claim` (footnote ref + server/tool/argsHash/timestamp); each failure → an explicit `Gap`. A startup-failed server that a task targeted is a gap (`server-unavailable`), and a no-text result is a gap (`empty-result`) — never invented filler. Emits `ProgressEvent`s (task-started/succeeded/failed, report-writing, done) for Q4 streaming.
  - **`report.ts`** (RG-02/04/05): `renderMarkdownReport` — deterministic, no-model scaffolding. Findings grouped by task with footnote-marked claims, an explicit **Gaps** section, and a **Provenance** table (ref → server/tool/argsHash/at). When there are no claims it says "No data could be retrieved" instead of padding.
  - **`write-gate.ts`** (Q6, design-now): `WriteApprovalGate` interface + `WriteTask`/`WriteDecision`, documented 5-point contract (write is a distinct task kind; admin write allowlist stricter than read; per-write human approval, audited, non-reusable; denied = terminal audited rejection). `ReadOnlyGate` (v1 default) refuses everything; `logWriteAttempt` records every attempt + decision. This is the seam a future write path plugs into without orchestrator rework.
  - **`factory.ts`**: `createOrchestrator` wires the real Markdown renderer + a File-Manager-backed, sandbox-confined report writer (RG-02/03).
- Bug found & fixed: `McpClientManager.getServer` threw a generic `Error` for a startup-failed server, so the orchestrator mis-classified it as `call-failed`. Now throws `McpCallError("server-unreachable")` → classified `server-unavailable`. Also made `extractText` accept both the unwrapped content array and a `{content}` wrapper.
- `tests/orchestrator.test.ts`: 17 new tests — multi-server fan-out, concurrency bound (stub manager), provenance references, gap reporting (call-failed / server-unavailable / empty-result), progress events, report rendering (footnotes + gaps + no-filler), write-gate refusal + audit, audit bridges, payload opt-in, JSONL ordering, transcript export, and an end-to-end run that writes a report to a confined dir. **94/94 pass**, typecheck + build green.
- Next: plugin interface (Claude Code / Codex) + the CLI/service entry point that composes config → enforcer → MCP manager → orchestrator.
- Committed as `42db211` and pushed.
- **Session paused.** Wrote `docs/NEXT_STEPS.md` — a self-contained resume point: status, what's already built (do not rebuild), remaining work in order (CLI/service entry point → Claude Code/Codex plugin → egress + sandbox conformance → model-engine seam), conventions to keep, and the suggested first action for the next session.

## 2026-08-18

### CLI / service entry point (NEXT_STEPS item 1)

Resumed from `docs/NEXT_STEPS.md`. Built the composition layer that turns the finished modules into a runnable `sandy` binary — the spine the plugin (item 2) and the conformance test (item 3) attach to.

- **`src/sandy.ts`** — `createSandy(deps)`: the startup sequence, wired in dependency order:
  1. `loadSandyConfig` (fail-closed, CP-04)
  2. `SandboxEnforcer.create` — refuses unsandboxed / runtime mismatch (throws); a *degraded* sandbox state is **not** thrown, it's audited (`sandbox_violation`) and surfaced via `check()`
  3. `JsonlAuditLogger` (when `auditFile` given) or `InMemoryAuditLogger` → derives `mcpAuditSink` + `fileAuditSink`
  4. `McpClientManager` + `NetworkGuard(allowed_network)` → `connectAll()`; startup failures are recorded, not fatal
  5. `FileManager` over `enforcer.paths`
  6. `createOrchestrator` (concurrency from `preferences.max_concurrent_mcp_calls`)
  `Sandy.check()` returns a serializable capability/health report; `Sandy.run()` executes an `OrchestratorRequest`; `Sandy.close()` closes MCP + flushes the audit log. Injectable `transportFactory`/`detection`/`probe`/`confinement` keep it testable.
- **`src/orchestrator/request.ts`** — `orchestratorRequestSchema` (Zod) + `toOrchestratorRequest`: the wire format for requests. Owned by the library so the CLI validates request files and the plugin (item 2) validates tool bodies with the **same** rules.
- **`src/cli.ts`** — `runCli(argv)`: verbs `check` (validate config + print capability/health report) and `run <request.json>` (execute a request, print claims/gaps, write the report). Flags: `-c/--config` (default `$SANDY_CONFIG` or `./sandy.json`), `-o/--audit` (JSONL path; default in-memory), `--json` (clean machine-readable stdout), `--no-progress`. Progress streams to **stderr** so `--json` stdout stays pipeable. Stable exit codes: `0` ok, `1` error, `2` usage, `3` config (fail-closed), `4` sandbox violation.
- **`bin/sandy.js`** + `package.json` `bin` entry. Also exportable: `createSandy`/`Sandy`/`runCli`/`EXIT`/request schema from `src/index.ts`.
- **Bug fixed in `src/mcp/managed-server.ts`:** on a failed `client.connect()`, the transport was never closed — a failed **stdio** connect leaked its spawned child process (and a failed SSE/streamable-HTTP connect could hold a socket), so the Node process **hung** on exit. `sandy check` against the example config would never return. Now the transport + client are torn down on connect failure. This is a production-relevant fix (terminal failures are now *clean* ones, MCP-10), and it's what made the process exit promptly.
- **`tests/sandy.test.ts`** (11 new tests) + **`tests/fixtures/stdio-mcp-server.mjs`** (a real stdio MCP server spawned by the CLI for the strongest e2e). Covers: healthy composition + `check()`; end-to-end `run()` (claim provenance, confined report write, JSONL audit mirroring); startup-failed server reported as `server-unavailable` (never thrown, never hidden); fail-closed unsandboxed (`SandboxViolationError`) and missing config (`ConfigError`); CLI exit codes (healthy check `--json`, real-stdio `run`, missing config → 3, invalid request → 2, unknown verb → 2, `--help` → 0).
- **Verified by hand:** `node bin/sandy.js check --json` (healthy, `ok:true`) and `run` (streaming progress on stderr, provenance claim, report written to the confined `reports/` dir, JSONL audit with `session_start/mcp_call/orchestrator_task/file_mutation/session_end`) against a real stdio MCP subprocess. **105/105 pass** (was 94), typecheck + build green.
- Next: item 2 — the Claude Code / Codex plugin (expose `sandy.gather`/`report`/`files.*`/`status` as host-side tools over `createSandy`), then item 3 — the egress conformance test.

### Claude Code / Codex plugin (NEXT_STEPS item 2) — Phase 1 flagship

Built the plugin on top of `createSandy`. Key design decision (locked first): **the host LLM does the reasoning (PL-03); Sandy is exposed as a small set of host-side tools** over MCP, so the host calls `sandy.*` and composes the narrative. Everything stays sandboxed inside Sandy; the host only sees provenance + gaps.

- **`src/plugin/tools.ts`** — the tool-surface contract (single source of truth). Zod input schemas for every tool + result types:
  - `sandy.gather` (body = `OrchestratorRequest.gather`) → claims + gaps + progress
  - `sandy.report` (body = gather + `report`) → claims + gaps + progress + reportPath + reportContent
  - `sandy.status` → the same capability/health report as `sandy check --json` (reused, not duplicated)
  - `sandy.files.read|list|write|delete|mkdir|rename` → thin wrappers over `FileManager`
- **`src/plugin/state.ts`** — `PluginSession` (one `Sandy` per config) + `SessionCache` (reuse across a host's many tool calls; don't re-run startup/MCP-connect per call) + `ProgressCollector` (Q4 progress is collected in-band and returned on the result, since a host usually only surfaces the final tool result, not a streamed terminal).
- **`src/plugin/api.ts`** — `SandyPluginAPI`, the host-agnostic controller each tool binds to. It validates every body against the tool schema (`ToolInputError` carries field-level issues so the host LLM can correct the call), delegates to the composed Sandy, and shapes results. **Confirmation-gated file ops return `needsConfirmation` instead of acting** — Sandy never auto-confirms (FM-04); the host asks the user and re-invokes with `confirmed: true`. **Every `sandy.files.*` tool reports errors as a structured `{reason, detail}` (never throws to the host)** — a sandbox violation, io error, or not-found is a result the LLM can read, not a crash.
- **`src/plugin/mcp-server.ts`** — the actual host adapter: an MCP stdio server (`name: "sandy"`, PL-04) that registers the nine `sandy.*` tools from the `tools.ts` schemas and delegates to `SandyPluginAPI`. A `wrap()` helper JSON-encodes results into MCP text blocks and surfaces errors in-band (a thrown error would be lost to the LLM). Entry point `node dist/plugin/mcp-server.js <sandy.json>` (config via argv, `SANDY_CONFIG`, or `sandy.json` in cwd).
- **`plugin/.claude-plugin/plugin.json`** — the host manifest (declares `sandy` as a stdio MCP server). **`plugin/install.sh`** — manual install per Q3 (git repo + manual, no registry): copies the manifest + `dist/` into the host's plugin dir. `package.json` gained a `files` field so `dist`/`bin`/`plugin` ship.
- **`tests/plugin.test.ts`** (7 tests): gather (provenance + gaps + progress), report (confined write + returned content), schema rejection (`ToolInputError`), status, the full files flow (write→read→list→rename→delete with the confirmation gate), path-confinement refusal surfaced as a structured error, and a **real MCP-protocol round-trip** (in-memory client ↔ `createSandyMcpServer`) asserting the nine tools are listed and `sandy.status`/`sandy.gather` answer over the wire.
- **Verified by hand:** drove `dist/plugin/mcp-server.js` over a real stdio JSON-RPC handshake — `serverInfo {name: sandy}`, all nine tools listed, `sandy.status` returned `ok:true` with the fixture `crm` connected.
- **Open (documented in NEXT_STEPS):** how the host surfaces `ProgressEvent`s in its UI (collected in-band now; a host that only shows final results sees them on the result object).
- **112/112 tests pass** (was 105), typecheck + build green.
- Next: item 3 — the egress conformance test (launch success criterion), then item 4 sandbox conformance.

### Egress conformance test (NEXT_STEPS item 3) — launch success criterion

Proved "zero network egress outside declared MCP endpoints" (SB-09 / PRD §11-12) two ways: **in-process** (always runs in CI) and **at the network level in Docker** (the strongest claim, first-class and CI-runnable).

- **`src/mcp/transports.ts` — made egress blocks auditable.** `guardedFetch` now takes an optional `AuditLogger` and, when it refuses a dial, records an `egress_blocked` event (AU-01). The event type existed but was never wired — a block is now a fact in the audit trail, not a silent throw.
- **`conformance/ep-server.mjs`** — a real **streamable-HTTP** MCP endpoint (exposes `read_deals`) that listens on a port. Optional `EP_LOG` env makes it append every request it receives — that file is the network-level "egress is observable" signal (the declared endpoint is hit, and it says so). Stateless streamable-HTTP needs a fresh `McpServer`+transport per request (the SDK binds one protocol to one connection) — that was the one non-obvious gotcha.
- **`conformance/egress.test.ts`** (5 tests, in-process, always runs):
  1. a real run against the live HTTP endpoint — **every URL dialed is the declared endpoint** (recording fetch under `guardedFetch`);
  2. an undeclared endpoint is refused and **the dial never happens** (VPN-02);
  3. an egress block is **recorded as `egress_blocked`** in the audit log (AU-01);
  4. a full `createSandy` run routes **all** egress through the guard to the one declared endpoint;
  5. the loader **fails closed** on a remote endpoint not in `allowed_network` (VPN-02, config-time).
- **`conformance/Dockerfile`** + **`conformance/run-docker.sh`** (network-level, Docker). The sandbox boundary is a Docker **`--internal` network** — the runtime guarantees a container on it has *zero* external egress; it can only reach other containers on that network. So the declared MCP endpoint = an EP container on the network; the internet / other hosts = unreachable by boundary. Asserts:
  1. `sandy run` **succeeds** against the single declared endpoint (provenance claim + confined report) and the EP logs that it was actually hit;
  2. an independent **external-egress probe from inside the sandbox FAILS** (explicit, verifiable: the boundary blocks non-declared egress);
  3. the reverse — a config with an endpoint **not in `allowed_network` fails closed** at startup (VPN-02) and the EP is **never reached**.
- **Scripts:** `npm run test:conformance` (in-process), `npm run conformance:docker` (build + Docker), `npm run conformance` (both).
- **Verified:** in-process 5/5; Docker harness PASSES all three (run succeeded + EP hit, external egress BLOCKED, VPN-02 fail-closed with nothing leaving), clean teardown.
- **Note:** SB-09 wants ≥2 sandboxes. Docker is done here. **Firejail is the same harness with the boundary command swapped** (the enforcer is runtime-agnostic) — left as item 4, since firejail isn't installed in this environment to verify against.
- **117/117 tests** (was 112) + conformance; typecheck + build green.
- Next: item 4 — sandbox conformance matrix (Docker + Firejail) in CI, proving the enforcer is runtime-agnostic.

### Sandbox conformance matrix (NEXT_STEPS item 4) — SB-09/10, runtime-agnosticity proof

Proved the enforcer is runtime-agnostic (SB-10): the SAME config + the SAME request, run under a Docker container AND a Firejail jail (both with no external egress), produce **byte-identical behavior**. This also surfaced and fixed a real detection bug.

- **Bug found & fixed in `src/sandbox/detect.ts` (`inFirejail`).** Real firejail (0.9.72, verified by installing it) sets `container=firejail` in the environment — it does NOT set `FIREJAIL=1` and does NOT create `/.firejail` in all builds. The detector only checked the latter two, so a firejail jail was never detected; on a Docker *host* the inherited cgroup/mountinfo then made it report `docker`, and a config declaring `firejail` was refused fail-closed with a runtime-mismatch (exit 4). Fixed by adding `ctx.env["container"] === "firejail"` and documenting why firejail is checked before docker (a firejail jail on a docker host must report firejail). Added 4 tests to `tests/sandbox.test.ts`, including the nested "firejail wins over inherited docker signals" case (the CI Docker-in-Docker scenario).
- **`conformance/stdio-server.mjs`** — a stdio MCP endpoint (mirrors the test fixture). stdio, not HTTP, so the fixture needs no network and the matrix isolates *boundary* behavior (detection / capability report / confinement / provenance) from egress (which `run-docker.sh` covers).
- **`conformance/signature.mjs`** — projects `sandy check`/`run` JSON onto the **runtime-agnostic behavior signature**: the capability decision (`ok`/`degraded`/`lost`/`summary`), the egress allowlist, the MCP fleet outcome (connected/failed), and the provenance (each claim's text/server/tool/`argsHash` + each gap's reason). It deliberately **drops** the fields that are legitimately runtime-specific (the detected runtime name + evidence, absolute workspace paths, wall-clock timestamps, durations, the full audit transcript) — so "identical behavior" is asserted where it means something, not on a naive byte diff that can never be stable.
- **`conformance/sandbox-matrix.sh`** — runs the same `check`+`run` under both boundaries and asserts: (1) each boundary reports `ok:true`, non-degraded, the `crm` server connected, a claim returned, and a report written to the confined dir; (2) **the two boundaries produce byte-identical signatures**. Modes: `SANDY_MATRIX=docker|firejail` (one leg, for CI) or unset (both + the cross-boundary diff). `SANDY_REQUIRE=1` fails closed when a boundary is missing (CI uses it); otherwise a missing boundary is reported and skipped so the suite stays green on hosts without it. The Docker leg runs `--network none`; the Firejail leg runs non-root with `--net=none` (host paths resolve in the default jail, so no root-only `--bind` is needed).
- **`conformance/Dockerfile`** — now ships both `ep-server.mjs` (egress) and `stdio-server.mjs` (matrix) so one image serves both harnesses.
- **`.github/workflows/ci.yml`** — the CI smoke matrix. `core` (typecheck/build/test + in-process conformance, no Docker needed) → `conformance` (matrix over `docker`+`firejail`, each leg self-contained and fail-closed via `SANDY_REQUIRE=1`, uploads its signature) → `identity` (downloads both signatures, requires them byte-identical — the CI-level form of the in-script cross-boundary assertion).
- **Scripts:** `npm run conformance` now runs in-process → egress (Docker) → sandbox matrix (Docker+Firejail). Also `conformance:sandbox`, `:docker`, `:firejail` for single legs.
- **Verified locally (Docker + Firejail both present):** `sandy check`/`run` succeed under each boundary; signatures byte-identical; the detector reports `docker` inside docker and `firejail` inside firejail (and still `firejail` when docker cgroup markers are also present); the skip path (boundary missing, REQUIRE=0) exits 0 and the fail-closed path (REQUIRE=1) exits 1; the egress harness still passes with the extended image. **121/121 tests** (was 117, +4), typecheck + build green.
- Next: item 5 — model-engine wiring (plugin mode: feed `logModelInvocation` from the host; standalone: leave the `LlmEngine` seam for Phase 2).
