# High-Priority Fix Plan — Sandbox-Detection Bypass + Silent Unauthenticated MCP Auth

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two High findings from `2026-08-22-full-repo-review.md` — a production-code sandbox-detection bypass reachable via one environment variable (H1), and MCP auth types that validate but silently connect unauthenticated (H2) — without weakening test coverage or changing any documented, working behavior.

**Architecture:** Both fixes remove a "silently do the unsafe thing" fallback and replace it with either (a) removing the ambient bypass and routing the same test need through the existing, already-injected dependency-injection seam (`SandyDeps`), or (b) failing closed with a clear error instead of degrading silently — the same pattern the rest of the codebase already uses everywhere else (`ConfigError`, `SandboxViolationError`, `McpCallError`).

**Tech Stack:** TypeScript (strict, ESM, Node ≥ 22), Vitest.

**Spec:** `reviews/2026-08-22-full-repo-review.md` §H1, §H2 — this plan implements those two findings exactly as scoped there.

## Global Constraints

- Fail closed, never smooth over a gap (project-wide convention, `docs/NEXT_STEPS.md` "Conventions to keep").
- No behavior change to any currently-passing test's *intent* — only to the mechanism by which tests achieve determinism (Task 1) or to what happens on a currently-unimplemented/untested auth path (Task 2, which today has no test coverage at all).
- Run `npm run typecheck && npm test` after each task; both must be green before moving on.
- `npm run build` must stay green (these are `src/` changes shipped in `dist/`).

---

## Task 1: Remove the `SANDY_TEST_RUNTIME` production bypass; thread the existing `detection` override through `runCli` instead

**Files:**
- Modify: `src/sandbox/detect.ts:100-118` (`detectRuntime()`)
- Modify: `src/cli.ts:315-331` (`withSandy()`), `src/cli.ts:342-357` (`runServe()`), `src/cli.ts:404` (`runCli()` signature)
- Modify: `tests/sandy.test.ts:417-423` (the `runCli` describe block that currently sets the env var)
- Modify: `tests/loop.test.ts:428-429` (same pattern)
- Test: the existing tests in both files above (no new test file — this task changes *how* existing tests achieve determinism, it doesn't add new behavior)

**Interfaces:**
- Consumes: `SandyDeps.detection?: () => RuntimeDetection` (already exists, `src/sandy.ts:56-57`); `RuntimeDetection` type from `src/sandbox/detect.ts`.
- Produces: `runCli(argv: string[], overrides?: Partial<SandyDeps>): Promise<number>` — the new second parameter. `bin/sandy.js` and the direct-run guard at the bottom of `cli.ts` continue calling `runCli(process.argv.slice(2))` with **no** second argument, so production has no code path that can inject a detection override.

### Why this shape

`detectRuntime()` already has exactly one legitimate caller path for a test-supplied override: `SandboxEnforcer.create()` accepts an optional `detection` function (`src/sandbox/enforcer.ts:59`), which flows from `SandyDeps.detection` (`src/sandy.ts:177-181`). Every test that calls `createSandy(...)` directly already uses this — e.g. `tests/loop.test.ts:419`: `createSandy({ sandyPath: cfg, ..., detection: pinnedDetection })`. The *only* reason the env-var hack exists is that `runCli()` builds `createSandy` internally (via `withSandy`/`runServe`) with no parameter for a test to inject `detection` through. Fix that gap directly instead of leaving a global env-var escape hatch in the shipped `detectRuntime()`.

- [ ] **Step 1: Write the failing/red-then-green test change in `tests/sandy.test.ts`**

Replace the env-var line with an explicit override object passed to every `runCli(...)` call in that describe block. Current code (`tests/sandy.test.ts:417-423`):

```ts
describe("runCli: verbs + exit codes (real stdio MCP server)", () => {
  // The CLI builds createSandy internally and cannot inject a detection dep,
  // so pin the real-detection path via the test override to a concrete runtime
  // ("docker"; the declared runtime stays "custom"). This keeps the CLI tests
  // deterministic on any host (CI runs on a bare VM where detectRuntime()
  // reports "none", which a custom-declared boundary would flag as degraded).
  process.env["SANDY_TEST_RUNTIME"] = "docker";

  const stdioCommand = [process.execPath, fixtureServer];
```

Replace with:

```ts
describe("runCli: verbs + exit codes (real stdio MCP server)", () => {
  // The CLI builds createSandy internally; runCli's second parameter lets a
  // caller inject SandyDeps overrides (detection, in this case) without any
  // ambient env var. This keeps the CLI tests deterministic on any host (CI
  // runs on a bare VM where detectRuntime() reports "none", which a
  // custom-declared boundary would flag as degraded) with no production code
  // path able to spoof sandbox detection.
  const cliOverrides = { detection: () => ({ runtime: "docker" as const, evidence: ["test override"] }) };

  const stdioCommand = [process.execPath, fixtureServer];
```

Then update every `runCli([...])` call in this describe block (lines 468, 479, 488, 496; leave 501/`["frobnicate"]` and 506/`["--help"]` as-is — those never reach `withSandy`, so they need no override) to pass `cliOverrides` as the second argument, e.g.:

```ts
runCli(["check", "--config", cfg, "--json", "--no-progress"], cliOverrides),
```

- [ ] **Step 2: Same change in `tests/loop.test.ts`**

Current code (`tests/loop.test.ts:428-429`):

```ts
describe("runCli: `ask` verb (standalone)", () => {
  process.env["SANDY_TEST_RUNTIME"] = "docker";
```

Replace with:

```ts
describe("runCli: `ask` verb (standalone)", () => {
  const cliOverrides = { detection: () => ({ runtime: "docker" as const, evidence: ["test override"] }) };
```

Update its `runCli([...])` calls (lines 497, 503) to pass `cliOverrides` as the second argument.

- [ ] **Step 3: Run the affected tests to confirm they now fail (the CLI doesn't accept a second argument yet)**

Run: `npx vitest run tests/sandy.test.ts tests/loop.test.ts`
Expected: type error / test failures — `runCli` doesn't accept a second parameter yet, and with no override the real `detectRuntime()` will report `"none"` on most dev/CI hosts, which a `"custom"`-declared sandbox boundary flags as degraded, changing `sandy check`'s `ok` field and any assertions on it.

- [ ] **Step 4: Add the `overrides` parameter to `runCli` and thread it through `withSandy`/`runServe`**

In `src/cli.ts`, change the `withSandy` helper (currently lines 315-331):

```ts
async function withSandy<T>(
  args: ParsedArgs,
  fn: (sandy: Sandy) => T | Promise<T>,
  overrides: Partial<SandyDeps> = {},
): Promise<T> {
  const sandyPath = resolveConfigPath(args.configPath);
  const sink = progressSink(args.progress);
  const sandy = await createSandy({
    sandyPath,
    auditFile: args.auditFile,
    onProgress: sink,
    ...overrides,
  });
  try {
    return await fn(sandy);
  } finally {
    await sandy.close();
  }
}
```

Change `runServe` (currently lines 342-357) the same way:

```ts
async function runServe(args: ParsedArgs, overrides: Partial<SandyDeps> = {}): Promise<number> {
  const sandyPath = resolveConfigPath(args.configPath);
  const sink = progressSink(args.progress);
  const sandy = await createSandy({
    sandyPath,
    auditFile: args.auditFile,
    onProgress: sink,
    ...overrides,
  });
  // ... unchanged below this point
```

Add the `SandyDeps` import (`src/cli.ts` already imports `type Sandy` from `./sandy.js` at line 8 — extend that import to include `type SandyDeps`).

Change `runCli`'s signature and thread `overrides` to every call site that invokes `withSandy`/`runServe` (currently lines 404, 420-440):

```ts
export async function runCli(argv: string[], overrides: Partial<SandyDeps> = {}): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return EXIT.ok;
  }
  if (args.version) {
    process.stdout.write(`${CLI_NAME} (sandy) — MCP-only, VPN-safe, audit-logged\n`);
    return EXIT.ok;
  }
  if (args.error) {
    process.stderr.write(`error: ${args.error}\n\nRun '${CLI_NAME} --help' for usage.\n`);
    return EXIT.usage;
  }

  try {
    if (args.verb === "check") {
      const report = await withSandy(args, (s) => s.check(), overrides);
      if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(formatCheckText(report, args.auditFile) + "\n");
      return EXIT.ok;
    }
    if (args.verb === "serve") {
      return await runServe(args, overrides);
    }
    if (args.verb === "ask") {
      const result = await withSandy(args, (s) => s.ask(args.goal!), overrides);
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(formatAskText(result, args.auditFile) + "\n");
      return EXIT.ok;
    }
    // verb === "run"
    const request = await loadRequest(args.requestFile!);
    const result = await withSandy(args, (s) => s.run(request), overrides);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(formatRunText(result, args.auditFile) + "\n");
    return EXIT.ok;
  } catch (err) {
    const runErr = translateError(err);
    process.stderr.write(`error: ${runErr.message}\n`);
    return runErr.code;
  }
}
```

Leave `bin/sandy.js` and the direct-run guard at the bottom of `cli.ts` (`void runCli(process.argv.slice(2)).then(...)`) unchanged — they call `runCli` with one argument, so `overrides` defaults to `{}` and production has no path to inject a detection override.

- [ ] **Step 5: Remove the `SANDY_TEST_RUNTIME` branch from `src/sandbox/detect.ts`**

Current code (`src/sandbox/detect.ts:100-107`):

```ts
export function detectRuntime(ctx: DetectionContext = defaultContext()): RuntimeDetection {
  // Test-only override: lets tests that exercise the real detection path
  // (e.g. the CLI, which builds createSandy internally and cannot inject a
  // detection dep) pin a runtime and stay deterministic on any host.
  const override = ctx.env["SANDY_TEST_RUNTIME"];
  if (override !== undefined) {
    return { runtime: (override as RuntimeDetection["runtime"]) || "none", evidence: ["test override"] };
  }
  if (inGvisor(ctx)) return { runtime: "gvisor", evidence: ["gVisor sentry characteristics"] };
```

Replace with:

```ts
export function detectRuntime(ctx: DetectionContext = defaultContext()): RuntimeDetection {
  if (inGvisor(ctx)) return { runtime: "gvisor", evidence: ["gVisor sentry characteristics"] };
```

(i.e. delete the `override` block entirely; everything else in the function is unchanged.)

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS, 169/169 (same count as before — this task changes zero test *behavior*, only how two describe blocks achieve determinism).

- [ ] **Step 7: Grep to confirm the bypass is fully gone**

Run: `grep -rn "SANDY_TEST_RUNTIME" --include="*.ts" .`
Expected: no matches anywhere in `src/` or `tests/`.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/sandbox/detect.ts tests/sandy.test.ts tests/loop.test.ts
git commit -m "security: remove SANDY_TEST_RUNTIME sandbox-detection bypass from production code

Route CLI test determinism through the existing SandyDeps.detection
injection seam (runCli now accepts optional overrides) instead of an
ambient environment variable checked unconditionally in detectRuntime().
Previously, setting SANDY_TEST_RUNTIME in any environment could make
Sandy believe it was sandboxed when it was not, bypassing the SB-03
'refuse to start without a boundary' guarantee entirely."
```

---

## Task 2: Fail closed on `oauth`/`mtls` MCP auth instead of silently connecting unauthenticated

**Files:**
- Modify: `src/mcp/transports.ts:36-54` (`authHeaders()`)
- Test: `tests/mcp.test.ts` (add a new test case; see Step 1 for exact placement/content)

**Interfaces:**
- Consumes: `McpServer`/`AuthConfig` types from `src/config/schema.ts` (`auth.type: "bearer" | "api_key" | "oauth" | "mtls"`, unchanged); `SecretResolver` from `src/config/loader.ts` (unchanged).
- Produces: `authHeaders()` now throws a plain `Error` for `auth.type === "oauth"` or `"mtls"` instead of returning `undefined`. `createTransport()` (which calls `authHeaders()` synchronously before constructing the SSE/HTTP transport) propagates that throw to its caller unchanged — no new type introduced. `ManagedServer.connect()` (`src/mcp/managed-server.ts:100-127`) already wraps `factory(...)`/`client.connect(...)` in a try/catch that sets health to `"unreachable"` and re-throws — a thrown `authHeaders()` error is therefore automatically surfaced as a normal terminal connect failure (MCP-10 semantics), with **no changes needed in `managed-server.ts` or `manager.ts`**.

- [ ] **Step 1: Write the failing test in `tests/mcp.test.ts`**

Add a new test (find the existing `describe` block that builds a `remoteServerSchema`-shaped `McpServer` fixture and calls `createTransport` — follow that file's existing fixture-construction pattern for a `transport: "http"` or `"sse"` server). Add:

```ts
it("createTransport throws for oauth auth (not yet implemented, fail closed)", () => {
  const server: McpServer = {
    name: "oauth-server",
    transport: "http",
    url: "https://internal.example.com/mcp",
    auth: {
      type: "oauth",
      client_id: "sandy-client",
      token_url: "https://internal.example.com/oauth/token",
    },
    version: "1.0.0",
    capabilities: ["read"],
    allowed_tools: ["read"],
  };
  const resolver = new SecretResolver({});
  const guard = new NetworkGuard(["internal.example.com"]);
  expect(() => createTransport(server, resolver, guard)).toThrow(/auth\.type "oauth" is not yet implemented/);
});

it("createTransport throws for mtls auth (not yet implemented, fail closed)", () => {
  const server: McpServer = {
    name: "mtls-server",
    transport: "http",
    url: "https://internal.example.com/mcp",
    auth: {
      type: "mtls",
      ca_bundle_path: "/etc/sandy/ca.pem",
      client_cert_path: "/etc/sandy/client.pem",
      client_key_path: "/etc/sandy/client.key",
    },
    version: "1.0.0",
    capabilities: ["read"],
    allowed_tools: ["read"],
  };
  const resolver = new SecretResolver({});
  const guard = new NetworkGuard(["internal.example.com"]);
  expect(() => createTransport(server, resolver, guard)).toThrow(/auth\.type "mtls" is not yet implemented/);
});
```

Add any missing imports (`createTransport`, `McpServer`, `SecretResolver`, `NetworkGuard`) if the file doesn't already import them — check the top of `tests/mcp.test.ts` first, since it likely already imports most of these for existing transport tests.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run tests/mcp.test.ts -t "not yet implemented"`
Expected: FAIL — `authHeaders()` currently returns `undefined` instead of throwing, so `createTransport` succeeds and `expect(...).toThrow(...)` fails.

- [ ] **Step 3: Fix `authHeaders()` to fail closed**

Current code (`src/mcp/transports.ts:36-54`):

```ts
function authHeaders(server: McpServer, resolver: SecretResolver): Record<string, string> | undefined {
  if (server.transport !== "sse" && server.transport !== "http") return undefined;
  const auth = server.auth;
  if (!auth) return undefined;
  if (auth.type === "bearer") {
    const token = auth.token ? resolver.resolve(auth.token) : undefined;
    if (token === undefined) return undefined;
    return { Authorization: `Bearer ${token}` };
  }
  if (auth.type === "api_key") {
    const token = auth.token ? resolver.resolve(auth.token) : undefined;
    if (token === undefined) return undefined;
    return { Authorization: `Bearer ${token}` };
  }
  // oauth/mtls require the transport's own authProvider machinery; wiring a
  // full OAuthClientProvider is a Phase 1 follow-up. Bearer/API-key cover the
  // launch servers.
  return undefined;
}
```

Replace the trailing comment + `return undefined;` with:

```ts
  // oauth/mtls require the transport's own authProvider/mTLS-cert machinery,
  // which is not wired up yet (a Phase 1 follow-up). Fail closed rather than
  // silently connecting unauthenticated to a server the config says needs
  // oauth/mtls — a config that validates must not produce a weaker runtime
  // guarantee than it declares.
  throw new Error(
    `MCP server "${server.name}": auth.type "${auth.type}" is not yet implemented ` +
      `(oauth/mtls require the transport's own authProvider/certificate machinery). ` +
      `Refusing to connect unauthenticated. Use "bearer" or "api_key" auth today, or omit auth.`,
  );
}
```

(The `bearer`/`api_key` branches above are unchanged — only the final fallthrough changes from `return undefined` to `throw`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/mcp.test.ts -t "not yet implemented"`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite and typecheck to confirm no regression**

Run: `npm run typecheck && npm test`
Expected: PASS, 171/171 (169 existing + 2 new). Specifically confirm no existing test constructs an `oauth`/`mtls` server and expects a successful connect — none should, per the review's finding that this path is currently untested, but verify by checking the diff in the test run output has no unexpected failures.

- [ ] **Step 6: Manually verify the terminal-failure surfacing (no code change needed, verification only)**

Read `src/mcp/managed-server.ts:100-127` (`ManagedServer.connect()`) to confirm the existing try/catch around `factory(...)`/`client.connect(...)` already handles a synchronous throw from `authHeaders()` (via `createTransport`) the same way it handles any other connect failure: `setHealth("unreachable", ...)`, releases any partially-created transport/client, and rethrows. This is existing, already-tested behavior (see `tests/mcp.test.ts`'s existing "failed connect" cases) — no new code needed here, just confirm by reading that the new throw path doesn't hit any code that assumes `createTransport` never throws before a transport object exists. (It doesn't: `factory(...)` in `connect()` is called directly inside the `try`, `src/mcp/managed-server.ts:106-109`.)

- [ ] **Step 7: Commit**

```bash
git add src/mcp/transports.ts tests/mcp.test.ts
git commit -m "security: fail closed on oauth/mtls MCP auth instead of connecting unauthenticated

authHeaders() previously returned undefined for auth.type 'oauth'/'mtls',
so a server config that validated as correctly requiring oauth or mtls
authentication silently connected with no auth headers and no client
certificate at runtime. Now throws a clear 'not yet implemented' error,
which ManagedServer.connect() already surfaces as a normal terminal
connect failure (MCP-10) — consistent with the rest of the codebase's
fail-closed conventions."
```

---

## Post-plan verification

- [ ] `npm run typecheck && npm run build && npm test` all green.
- [ ] `grep -rn "SANDY_TEST_RUNTIME" .` (excluding `.git`, `node_modules`, `dist`) returns nothing.
- [ ] `grep -n "oauth\|mtls" src/mcp/transports.ts` shows the new throw, not a silent `return undefined`.
- [ ] Update `docs/DIARY.md` per this repo's convention ("update docs/DIARY.md per work block") with a short entry describing both fixes and pointing at this plan file.
- [ ] Per `AGENTS.md`: commit (done per-task above) and push to `origin/master`.
