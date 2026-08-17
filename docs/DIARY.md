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
