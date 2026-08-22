# Full Repository Review — 2026-08-22

**Review date:** 2026-08-22
**Reviewed at HEAD commit:** `9e98388a4cacdbf2d31221274a4508b2f6fcb3a8` (branch `master`)
**Commit subject:** `PHASE2_DESIGN: update top status header for the real-model proof + §7`
**Working tree state at review time:** clean; `npm run typecheck`, `npm test` (169/169), and `npm audit` all green.
**Reviewer:** Claude (Sonnet 5), via a manual file-by-file pass plus a backgrounded `code-review --level high` multi-agent pass over `src/`.

> **Note to future agents:** this review is pinned to the commit above. Before trusting any specific finding, check `git log <commit>..HEAD -- <file>` for the file in question — if it has changed since, re-verify the finding against current code rather than assuming it still applies. The two fix plans in this directory (`2026-08-22-fix-plan-high-priority.md`, `2026-08-22-fix-plan-medium-low-priority.md`) implement the findings below; check their status before re-doing this work.

## Overall assessment

This is an unusually disciplined codebase for its stage. `npm test` is 169/169 green, typecheck is clean, `npm audit` reports zero vulnerabilities, there is not a single `TODO`/`FIXME` left in `src/`, and the fail-closed philosophy (bad config → refuse to start, missing env var → refuse, unsandboxed → refuse, unknown MCP tool → refuse before it hits the wire) is applied consistently, not just asserted in docs. Symlink-escape protection in `PathConfinement`, byte-identical Docker/Firejail conformance signatures in CI, and provenance-hashed claims in every report are real engineering, not decoration.

The findings below are everything worth fixing, not a verdict that the project is unsound. None of them undermine the core architecture; most are either an inconsistency between two code paths that are supposed to agree, or a corner the "fail-closed everywhere" principle didn't quite reach.

---

## High priority (2)

### H1 — `SANDY_TEST_RUNTIME` is a test-only sandbox-detection override that ships live in production code

**File:** `src/sandbox/detect.ts:104` (`detectRuntime()`)
**Also touches:** `src/sandbox/enforcer.ts:59` (`SandboxEnforcer.create()` calls `detectRuntime` by default), `src/sandy.ts` (`SandyDeps.detection`), `tests/sandy.test.ts:423`, `tests/loop.test.ts:429`

`detectRuntime()` checks `process.env["SANDY_TEST_RUNTIME"]` *before* any real detection logic runs, and if set, returns that value unconditionally:

```ts
const override = ctx.env["SANDY_TEST_RUNTIME"];
if (override !== undefined) {
  return { runtime: (override as RuntimeDetection["runtime"]) || "none", evidence: ["test override"] };
}
```

This exists so `tests/sandy.test.ts` and `tests/loop.test.ts` can pin a deterministic runtime when exercising `runCli()` end-to-end (the CLI builds `createSandy` internally with no way to inject `SandyDeps.detection` from outside). But the check lives in the **shipped module**, unconditionally, in every environment — there's no `NODE_ENV` guard, no build-time strip. `SandboxEnforcer.create()` calls `detectRuntime` by default whenever no `detection` override is passed.

The entire launch thesis of this project is "Sandy refuses to start without a boundary" (SB-03). That guarantee is fully defeated by anyone who can set one environment variable in the process's environment — an inherited shell profile, a CI runner default, a compromised dependency's postinstall script, or a misconfigured deployment wrapper. This is invisible in solo/local development and becomes a real problem the moment the binary runs somewhere untrusted input could reach the environment.

**Severity:** High — it's a complete, silent bypass of the project's central security invariant, reachable with no privilege beyond setting an env var.

### H2 — `mtls`/`oauth` MCP auth types validate successfully but produce zero authentication at runtime

**File:** `src/mcp/transports.ts:36-53` (`authHeaders()`)
**Also touches:** `src/config/schema.ts` (`authSchema`)

`authSchema` in `src/config/schema.ts` requires and validates the right fields for `oauth` (`client_id` + `token_url`) and `mtls` (`ca_bundle_path` + `client_cert_path` + `client_key_path`) — so an admin's config passes schema validation and *looks* correctly configured. But `authHeaders()` explicitly falls through to `return undefined` for both types:

```ts
// oauth/mtls require the transport's own authProvider machinery; wiring a
// full OAuthClientProvider is a Phase 1 follow-up. Bearer/API-key cover the
// launch servers.
return undefined;
```

Nothing throws. `createTransport()` builds the transport anyway, with no auth headers and no client certificate. The result: a server an operator believes is protected by mTLS or OAuth gets called completely unauthenticated, and Sandy reports it as normally connected — no error, no degraded state, nothing in `sandy check` output to indicate the gap.

**Severity:** High — this is a fail-*open* bug in a codebase whose stated organizing principle is "policy > preferences, tighten-never-loosen" and whose config schema explicitly promises a guarantee ("this server requires mTLS") that the runtime silently doesn't keep.

---

## Medium priority

### M1 — Egress allowlist can never match a declared endpoint at its scheme's default port

**Files:** `src/config/loader.ts:148`, `src/sandbox/network.ts` (`endpointOf()`)

Both places compute the allowlist comparison key as `url.port ? "host:port" : "host"`. WHATWG's `URL` parser normalizes away the port when it equals the scheme's default (443 for `https`, 80 for `http`) **even when written explicitly**:

```
$ node -e "console.log(new URL('https://internal.company.com:443').port)"
                                                                    (empty string)
```

So any `allowed_network` entry written as `host:443` (the exact form the schema's own docstring suggests: `"e.g. internal.company.com:443"`, and the exact form the shipped `config/sandy.json` uses: `"allowed_network": ["internal.company.com:443", "jira.internal:8443"]`) can **never** match a real HTTPS MCP server URL on that host — the computed endpoint is always the bare hostname. `loadSandyConfig` throws `ConfigError` ("not in sandbox.allowed_network") at startup for a config that looks and reads as correct. The identical bug in `NetworkGuard.check()`/`endpointOf()` means even if you worked around it in the config loader, the runtime egress gate would independently reject the same call.

Practical impact: **this makes the documented, intuitive way to write `allowed_network` for a standard-port HTTPS/HTTP endpoint permanently broken**, including in the project's own example config. This is arguably more severe in practice than its "medium" bucket suggests, precisely because it sits inside the core VPN-02 egress control — it's grouped here rather than with H1/H2 mainly for continuity with the fix-plan split already agreed with the user, not because its impact is smaller. **Recommend treating this as the first item to fix in the medium/low pass.**

### M2 — `file-manager.ts`: `rename()` bypasses the mandatory overwrite-confirmation gate

**File:** `src/files/file-manager.ts:301` (`rename()`)

`write()` explicitly checks whether the destination exists and requires `"overwrite"` confirmation if so (`src/files/file-manager.ts:191-192`). `rename()` never performs the equivalent check — it only gates on `"rename"` confirmation (`requireConfirmation("rename", ...)`), and `"rename"` is not in the schema's forced-minimum `confirmation_required` list (only `"delete"` and `"overwrite"` are forced — `src/config/schema.ts:232-239`). Since Node's `fs.rename` silently overwrites an existing destination file, `fm.rename("draft.md", "important-existing.md")` under the *default* policy clobbers `important-existing.md` with **zero confirmation of any kind**, even though the equivalent `fm.write()` call to the same destination is mandatorily gated.

### M3 — `file-manager.ts`: `list()` computes ignore-pattern matches against the wrong root, leaking excluded filenames

**File:** `src/files/file-manager.ts:145` (`walk()`) vs. `src/files/file-manager.ts:382-394` (`assertNotIgnored()`/`containingRoot()`)

`read()`/`write()`/`delete()` compute the ignore-pattern relative path against the **confinement root** via `containingRoot()`. `list()`'s recursive `walk()` computes it against the **queried directory itself** (`root = abs`, the directory passed to `list()`). With `ignore_patterns: ["secrets/*.key"]`, `read("secrets/api.key")` is correctly blocked (`rel = "secrets/api.key"` matches), but `list("secrets")` computes `rel = "api.key"` for the same file — the pattern never matches, and the filename is returned to the caller (which may be an MCP-connected LLM). A top-level `list(".")` walking recursively into `secrets/` would filter correctly; only a *direct* `list("secrets")` leaks. Easy to miss in testing because the common case (list from the root) works.

### M4 — `file-manager.ts`: undo (`reverse()`) skips confinement re-resolution — a TOCTOU symlink-escape path

**File:** `src/files/file-manager.ts:413-442` (`reverse()`)

Every live mutation (`write`, `deleteFile`, `createDirectory`, `rename`, `deleteDirectory`) resolves its path through `PathConfinement.resolve()`, which re-checks real paths and refuses symlink escapes. `reverse()` — the undo implementation — instead writes/deletes/renames using the **raw path stored in the journal record**, via bare `node:fs` calls, with no re-resolution through `PathConfinement`. If a path is replaced with a symlink pointing outside the declared roots *between* the original mutation and a later `undo()` call in the same session, `reverse()` follows that symlink with no check — exactly the class of attack `PathConfinement.resolve()` exists to prevent, unprotected on this one path.

### M5 — `file-manager.ts`: undo is invisible to the audit trail

**File:** `src/files/file-manager.ts:413` (`reverse()`)

Every forward mutation calls `this.audit.record(...)`. `reverse()` never does. A `write()` is audited; the subsequent `undo()` that reverts it produces **no audit entry at all** — disk state changes with no corresponding log line, breaking the "append-only record of every mutation" (AU-01) invariant for exactly the operation most likely to need forensic scrutiny.

### M6 — `file-manager.ts`: `deleteDirectory()`'s snapshot decision and delete decision use two different dry-run expressions

**File:** `src/files/file-manager.ts:352` (snapshot) vs. `:356` (actual delete)

```ts
const snapshot = dryRunOf(options) ? null : await snapshotDirectory(abs);   // options.dryRun ?? false
...
const dryRun = options.dryRun ?? this.policy.dry_run_default;               // different fallback
```

When `options.dryRun` is unset and `policy.dry_run_default` is `true`, `dryRunOf(options)` evaluates `false` (it never looks at policy) so `snapshotDirectory()` still runs a full recursive read of the subtree into memory — even though `dryRun` (computed two lines later, correctly) is `true` and nothing gets deleted. Wasted I/O at best; at worst, an unreadable file anywhere in the subtree makes a supposedly no-op dry-run call throw.

### M7 — `file-manager.ts`: binary files are corrupted by the undo snapshot mechanism

**File:** `src/files/file-manager.ts` — `write()`/`deleteFile()` prior-content capture, and `snapshotDirectory()`

`write()`, `deleteFile()`, and `snapshotDirectory()` (used by `deleteDirectory()`) all capture "before" content via `readFile(path, "utf8")` so undo can restore it. Any pre-existing binary file (image, PDF, archive) under the sandbox root that gets overwritten or deleted has its prior bytes UTF-8-decoded and re-encoded — a lossy round-trip. Undo of such an operation silently writes back corrupted bytes. No test exercises a binary file through this path.

### M8 — `engine.ts`: a timed-out/failed model invocation orphans the `llama-server` child process

**File:** `src/engine.ts:476-487` (`LlamaCppEngine.invoke()` catch block)

On any invocation failure (including a `withTimeout` rejection), the catch block sets `state = "degraded"` but never calls `killChild()`. `this.child` still references the live subprocess. The next call sees `!isReady()`, calls `start()` → `doStart()`, which does `this.child = this.spawnFactory(...)` (`src/engine.ts:326`) — silently overwriting the reference to the still-running old process. Repeated timeouts accumulate orphaned `llama-server` processes, each holding a port and consuming CPU/RAM, for the life of the parent.

### M9 — `orchestrator.ts`: an unrelated filename choice can discard an entire successful gather

**File:** `src/orchestrator/orchestrator.ts:226-243` (`Orchestrator.run()`)

`await this.writeReport(reportContent, file)` has no try/catch. `renderReport` always produces Markdown text, but `request.report.file` accepts any extension (no restriction in `orchestrator/request.ts`/`config/schema.ts`). If `file` is e.g. `"summary.json"`, `FileManager.write()` detects format `"json"` from the extension, `validateContent()` fails `JSON.parse` on the Markdown text, and throws `FileOpError("format-invalid", ...)` — which propagates **uncaught** out of `run()`. Every already-gathered claim and gap (potentially from many successful MCP calls) is discarded because of a filename choice unrelated to data quality; the caller gets a bare rejected promise instead of a partial result.

### M10 — `state.ts`: `SessionCache.get()` has a check-then-act race that can leak a `Sandy` instance

**File:** `src/plugin/state.ts:94-108` (`SessionCache.get()`)

```ts
const existing = this.sessions.get(resolved);
if (existing) return existing;
...
const sandy = await createSandy({ ... });   // await point — cache not yet updated
const session = { sandy, configPath: resolved, progress };
this.sessions.set(resolved, session);
```

Two concurrent tool calls against the same config path can both miss the cache before the first `await createSandy(...)` resolves. Both construct a full `Sandy` (MCP connections, and in standalone mode potentially two `LlamaCppEngine` processes racing for a port); the second `sessions.set()` silently overwrites the first. The first instance's resources are never referenced again and never closed by `closeAll()` — an unmanaged resource/process leak under concurrent host tool calls.

### M11 — Local API relies on incidental CORS behavior, not an explicit Origin check, and has a working bypass

**File:** `src/standalone/api.ts:391-406` (`readJsonBody()`), `:226-236` (`handle()`)

The loopback-only REST API is intentionally unauthenticated (documented rationale: loopback-only + single-user). But `readJsonBody()` never checks the `Content-Type` header, and `handleRequest()` never checks `Origin`/`Referer`. A cross-site request using `Content-Type: text/plain` is a CORS-"simple" request — it triggers no preflight — and the server happily `JSON.parse`s and executes the body regardless of declared content type. Any webpage open in the same browser as a running `sandy serve` can `fetch('http://127.0.0.1:<port>/run', {method:'POST', headers:{'Content-Type':'text/plain'}, body: JSON.stringify(req)})` and enqueue a real job with no confirmation — a working CSRF-style bypass of the "loopback = safe" assumption, not just a theoretical gap.

### M12 — Supply-chain: the `llama-server` binary has no integrity verification, unlike the model file

**File:** `scripts/provision-model.sh`

The model GGUF is SHA256-pinned and verified fail-closed (`MODEL_SHA256`, verified after download, file removed on mismatch). The `llama-server` binary — downloaded from a GitHub release tarball, extracted, `chmod +x`'d, and later executed as a subprocess with no sandboxing beyond Sandy's own — has **no checksum or signature check at all**. This is backwards from a risk standpoint: the binary is executable code; the model is inert weights. A compromised release asset or a MITM'd download would run completely undetected.

### M13 — Audit log write failures are unhandled

**File:** `src/audit/logger.ts:115-125` (`JsonlAuditLogger.append()`)

```ts
this.writeChain = this.writeChain.then(async () => {
  await mkdir(path.dirname(this.filePath), { recursive: true });
  await appendFile(this.filePath, line, "utf8");
});
```

No `.catch` anywhere in the chain. If `appendFile` fails mid-session (disk full, permissions, path removed externally), that's an unhandled promise rejection with no operator-visible signal — for a component whose entire job is "append-only, auditable, never smoothed over," a write failure should be loud, not silently swallowed (or, worse, crash the process via Node's unhandled-rejection handling with no diagnostic tying it back to the audit subsystem).

### M14 — No prompt-injection threat model for the standalone narrate step

**File:** `src/standalone/loop.ts` (`AutonomousLoop.narrate()`, `buildNarratePrompt()`)

`narrate()` feeds `claim.text` — content retrieved from internal systems via MCP, i.e. untrusted relative to the model — directly into the narration prompt via plain string concatenation, with no delimiting/escaping. A malicious or adversarially-worded document (a Jira ticket, a wiki page) fetched by a gather task could attempt to steer the local model's narrative. There's real mitigating design here (claims stay independently provenance-tracked in the report regardless of what the narrative says, and the narrative is explicitly labeled "may vary in quality"), but the risk class isn't named anywhere in `docs/` — worth stating explicitly for an enterprise-security audience rather than leaving it implicit in the mitigations.

---

## Low priority / polish

- **`LocalApi`'s job worker busy-polls every 5ms when idle** (`src/standalone/api.ts:293`, `for (;;) { ... await sleep(5); }`) instead of being event-driven. Harmless at current scale, wasteful for a long-lived service.
- **No `LICENSE` file**; `README.md` says "License: TBD" while the project bundles/depends on Apache-2.0 (Qwen3 model) and MIT-class (llama.cpp) components. For a tool explicitly pitched at compliance-conscious enterprises, this blocks anyone's legal review.
- **Hostname-based egress allowlisting has no IP pinning** (`NetworkGuard`) — a standard, accepted limitation class (DNS rebinding) for this kind of allowlist; fine under an admin-controlled internal-DNS trust model, but worth stating explicitly as an accepted limitation in `docs/DECISIONS.md` rather than leaving it implicit.
- **Documentation sprawl/duplication** — nine docs (`README.md` status section, `PRD.md`, `PRD_Claude.md`, `PRD_Final.md`, `DECISIONS.md`, `PHASE2_DESIGN.md`, `MODEL.md`, `NEXT_STEPS.md`, `DIARY.md`) with heavy narrative overlap between the README status block, `NEXT_STEPS.md`, and `DIARY.md` — the same milestones restated near-verbatim in three places. Fine for a solo/AI-paced project; a real cost once more engineers are reading it for ground truth.
- **Single-contributor git history**, no branch protection or required-review signal visible in the repo itself (CI runs on PRs per `.github/workflows/ci.yml`, but nothing enforces review). Expected at this stage; worth revisiting before the project scales to a team.

## Explicitly not a concern

The write-back gate (`ReadOnlyGate` refuses everything by default, contract designed but implementation deferred) is a legitimate, well-reasoned deferral, not a gap. The MCP retry/health/allowlist logic, the bounded job store, the graceful-shutdown ordering in `sandy serve`, and the `llama-server` stderr-vs-stdout port-discovery fix are all careful, tested work. Beyond the items listed above, no correctness bugs were found in the orchestrator's fan-out/gap logic, the config-loading fail-closed paths, or the plugin tool-input validation.
