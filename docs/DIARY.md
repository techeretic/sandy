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
- Next: File Manager (FM-01..08) on top of PathConfinement — CRUD with confirmations, ignore patterns, journal.
