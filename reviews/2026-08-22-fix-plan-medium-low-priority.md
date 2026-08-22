# Medium/Low-Priority Fix Plan — file-manager.ts consistency, engine leak, egress matching, and polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 14 medium and 4 low findings from `2026-08-22-full-repo-review.md` (§Medium, §Low priority). Each task is independent and can be picked up, reviewed, and merged on its own — there is no ordering dependency between tasks except where noted.

**Architecture:** Every fix follows the same shape the codebase already uses elsewhere: replace a silent divergence between two code paths that are supposed to agree, or a silently-swallowed failure, with either (a) making the two paths agree, or (b) surfacing the failure explicitly (an audited event, a thrown error, a reported field) instead of losing it.

**Tech Stack:** TypeScript (strict, ESM, Node ≥ 22), Vitest, bash (`scripts/provision-model.sh`).

**Spec:** `reviews/2026-08-22-full-repo-review.md` §Medium priority (M1–M14), §Low priority — this plan implements those findings in the same order they appear there. **Recommended execution order: M1 first** (the review flags it as higher real-world impact than its bucket suggests — it breaks the project's own example config), then M2–M7 (all in `file-manager.ts`, natural to batch), then M8–M14, then the low-priority items.

## Global Constraints

- Fail closed, never smooth over a gap (project-wide convention).
- Run `npm run typecheck && npm test` after each task; must be green before moving to the next.
- `npm run build` must stay green.
- Each task below is scoped to be committable independently — commit after each task's Step, don't batch multiple tasks into one commit.

---

## Task M1: Fix the egress-allowlist default-port matching bug

**Files:**
- Modify: `src/config/loader.ts:145-154` (the VPN-02 cross-check loop)
- Modify: `src/sandbox/network.ts:5-7` (`endpointOf()`)
- Test: `tests/config.test.ts` (add a case with an explicit default-port URL), `tests/sandbox.test.ts` (add a case for `NetworkGuard.check()` with a default-port URL)

**Interfaces:**
- Produces: a new shared helper `normalizedEndpoint(url: URL, scheme: "http" | "https"): string` — or simplest, fix both call sites in place using the same logic (they currently duplicate the buggy `url.port ? ... : ...` expression; keep them duplicated for minimal diff, or extract to `src/sandbox/network.ts` and import it from `loader.ts` — extracting is preferred since it removes the duplication that let the bug drift out of sync in the first place).

### The fix

The bug: `url.port` is `""` for a scheme's default port even when written explicitly (`new URL("https://host:443").port === ""`). Fix by falling back to the scheme's known default port instead of omitting the port:

- [ ] **Step 1: Write the failing test in `tests/config.test.ts`**

Add a test that constructs a config where `allowed_network` declares `"internal.company.com:443"` and the MCP manifest has an `https://internal.company.com/mcp` server (transport `"http"` or `"sse"`), and asserts `loadSandyConfig` succeeds (does NOT throw). Follow the existing fixture-writing helpers already in that file (`writeConfig`/similar — check the top of `tests/config.test.ts` for the established pattern of writing a temp `sandy.json` + `mcp-servers.json`).

```ts
it("allows an MCP server URL at the scheme's explicit default port when allowed_network declares that port", async () => {
  const ws = await tmpWorkspace();
  const cfg = await writeConfig(ws, {
    allowedPaths: [ws],
    allowedNetwork: ["internal.company.com:443"],
  });
  await writeManifest(ws, {
    servers: [
      {
        name: "docs",
        transport: "http",
        url: "https://internal.company.com/mcp",
        version: "1.0.0",
        capabilities: ["read"],
        allowed_tools: ["read"],
      },
    ],
  });
  await expect(loadSandyConfig(cfg)).resolves.toBeDefined();
});
```

(Adjust helper names/signatures to match whatever `writeConfig`/`writeManifest`-equivalent helpers actually exist in the file — read the file's existing tests first for the exact fixture API before writing this.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/config.test.ts -t "explicit default port"`
Expected: FAIL — `loadSandyConfig` throws `ConfigError: ... not in sandbox.allowed_network`.

- [ ] **Step 3: Fix `endpointOf()` in `src/sandbox/network.ts`**

Current code (`src/sandbox/network.ts:5-7`):

```ts
function endpointOf(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}
```

Replace with a version that falls back to the scheme's default port instead of omitting it, and export it so `loader.ts` can reuse the same logic:

```ts
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * The allowlist comparison key for a URL: "host:port". WHATWG's URL parser
 * normalizes away the port when it equals the scheme's default (443/80) even
 * when written explicitly, so we must reconstruct it rather than trust
 * `url.port` — otherwise "host:443" in an allowlist can never match a real
 * https URL on that host.
 */
export function endpointOf(url: URL): string {
  const port = url.port || DEFAULT_PORTS[url.protocol] || "";
  return port ? `${url.hostname}:${port}` : url.hostname;
}
```

Update the `NetworkGuard.check()` call site (a few lines below in the same file) if it references the old private function name — it already calls `endpointOf(url)`, so no change needed there beyond the function body above. Remove the old `function endpointOf` (non-exported) and confirm nothing else in the file relied on it being non-exported.

- [ ] **Step 4: Fix the VPN-02 cross-check in `src/config/loader.ts`**

Current code (`src/config/loader.ts:145-154`):

```ts
for (const server of manifest.servers) {
  if (server.transport !== "sse" && server.transport !== "http") continue;
  const url = new URL(server.url);
  const endpoint = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  if (!config.sandbox.allowed_network.includes(endpoint)) {
    throw new ConfigError(
      `MCP server "${server.name}" targets ${endpoint}, which is not in sandbox.allowed_network (VPN-02: egress restricted to declared endpoints)`,
    );
  }
}
```

Replace the local `endpoint` computation with the shared helper, importing it from `../sandbox/network.js`:

```ts
import { endpointOf } from "../sandbox/network.js";
// ... (add to the existing import block at the top of the file)

for (const server of manifest.servers) {
  if (server.transport !== "sse" && server.transport !== "http") continue;
  const url = new URL(server.url);
  const endpoint = endpointOf(url);
  if (!config.sandbox.allowed_network.includes(endpoint)) {
    throw new ConfigError(
      `MCP server "${server.name}" targets ${endpoint}, which is not in sandbox.allowed_network (VPN-02: egress restricted to declared endpoints)`,
    );
  }
}
```

This also means an admin can now write `allowed_network` entries WITHOUT the default port (e.g. just `"internal.company.com"`) and a `:443`/`:80` URL will still match, since both sides now normalize the same way — but an entry that omits the port only matches the *default* port for whichever scheme is used, since `endpointOf` always fills in a concrete port. Note this doesn't change behavior for non-default ports (e.g. `:8443`), which already worked correctly before this fix.

- [ ] **Step 5: Add the `NetworkGuard` runtime-level test in `tests/sandbox.test.ts`**

```ts
it("check() matches an endpoint declared without a port against a URL at the scheme's default port", () => {
  const guard = new NetworkGuard(["internal.company.com"]);
  expect(guard.check("https://internal.company.com/mcp").ok).toBe(true);
});

it("check() matches an endpoint declared with an explicit default port against the same URL", () => {
  const guard = new NetworkGuard(["internal.company.com:443"]);
  expect(guard.check("https://internal.company.com/mcp").ok).toBe(true);
  expect(guard.check("https://internal.company.com:443/mcp").ok).toBe(true);
});
```

- [ ] **Step 6: Run all the new/changed tests, then the full suite**

Run: `npx vitest run tests/config.test.ts tests/sandbox.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: PASS, no regressions (existing tests that use non-default ports like `:8443` must still pass unchanged).

- [ ] **Step 7: Verify the shipped example config now round-trips**

Run: `node -e "import('./dist/config/loader.js').then(m => m.loadSandyConfig('config/sandy.json').then(() => console.log('OK')).catch(e => { console.error(e.message); process.exit(1); }))"` after `npm run build` (this will still fail if `config/mcp-servers.json` doesn't exist or doesn't declare a server at `internal.company.com:443` / `jira.internal:8443` — check `config/mcp-servers.json`'s contents first; if it's a minimal/example manifest with no real servers at those hosts, this manual check may not directly apply. The real proof is Steps 1–6's tests.)

- [ ] **Step 8: Commit**

```bash
git add src/sandbox/network.ts src/config/loader.ts tests/config.test.ts tests/sandbox.test.ts
git commit -m "fix: correctly match egress-allowlist entries at a scheme's default port

url.port is empty for a scheme's default port (443/80) even when written
explicitly in the URL, so an allowed_network entry like 'host:443' could
never match a real https URL on that host -- including the project's own
shipped config/sandy.json example. endpointOf() now reconstructs the
default port instead of trusting url.port, and the config loader reuses
the same (now-exported) function instead of duplicating the buggy logic."
```

---

## Task M2: `file-manager.ts` — gate `rename()` on destination-overwrite the same way `write()` does

**Files:**
- Modify: `src/files/file-manager.ts:301-326` (`rename()`)
- Test: `tests/files.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("rename() requires overwrite confirmation when the destination already exists", async () => {
  const fm = /* construct per this file's existing pattern, default policy (confirmation_required: delete+overwrite) */;
  await fm.write("source.txt", "new content", { confirmed: true });
  await fm.write("dest.txt", "existing content", { confirmed: true });
  await expect(fm.rename("source.txt", "dest.txt")).rejects.toThrow(ConfirmationRequiredError);
});

it("rename() succeeds over an existing destination once confirmed", async () => {
  const fm = /* ... */;
  await fm.write("source.txt", "new content", { confirmed: true });
  await fm.write("dest.txt", "existing content", { confirmed: true });
  const result = await fm.rename("source.txt", "dest.txt", { confirmed: true });
  expect(result.applied).toBe(true);
});
```

(Match this file's existing helper for constructing a `FileManager` with a temp confined root — every other test in the file already does this.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/files.test.ts -t "overwrite confirmation"`
Expected: FAIL — today `rename()` does not check whether `dest.txt` exists, so it succeeds without confirmation.

- [ ] **Step 3: Fix `rename()`**

Current code (`src/files/file-manager.ts:301-326`):

```ts
async rename(from: string, to: string, options: FileOpOptions = {}): Promise<FileMutationResult> {
  const absFrom = await this.confinement.resolve(from);
  const absTo = await this.confinement.resolve(to);
  this.assertNotIgnored(absFrom, from);
  this.assertNotIgnored(absTo, to);

  await stat(absFrom).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileOpError("not-found", from, `no such file or directory: ${absFrom}`);
    }
    throw err;
  });

  this.requireConfirmation("rename", from, `rename ${absFrom} -> ${absTo}`, options);

  const dryRun = options.dryRun ?? this.policy.dry_run_default;
  if (!dryRun) {
    await this.io(from, () => rename(absFrom, absTo), { notFound: `cannot rename: ${absFrom}` });
  }
  ...
```

Replace with a version that checks whether the destination exists and, if so, requires `"overwrite"` confirmation in addition to (not instead of) the existing `"rename"` gate:

```ts
async rename(from: string, to: string, options: FileOpOptions = {}): Promise<FileMutationResult> {
  const absFrom = await this.confinement.resolve(from);
  const absTo = await this.confinement.resolve(to);
  this.assertNotIgnored(absFrom, from);
  this.assertNotIgnored(absTo, to);

  await stat(absFrom).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileOpError("not-found", from, `no such file or directory: ${absFrom}`);
    }
    throw err;
  });

  const destExists = await stat(absTo).then(() => true).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  });

  this.requireConfirmation("rename", from, `rename ${absFrom} -> ${absTo}`, options);
  if (destExists) {
    this.requireConfirmation("overwrite", to, `rename would overwrite existing destination ${absTo}`, options);
  }

  const dryRun = options.dryRun ?? this.policy.dry_run_default;
  if (!dryRun) {
    await this.io(from, () => rename(absFrom, absTo), { notFound: `cannot rename: ${absFrom}` });
  }
  ...
```

(Leave the rest of the method — the journal/audit record at the end — unchanged.)

- [ ] **Step 4: Run to verify it passes, then the full suite**

Run: `npx vitest run tests/files.test.ts` then `npm run typecheck && npm test`
Expected: PASS. Check for any existing test that renames onto an existing destination and currently expects success without `confirmed: true` — if one exists, it will now need `confirmed: true` added, since that test was relying on the bug. Search first: `grep -n "\.rename(" tests/files.test.ts` and inspect each call.

- [ ] **Step 5: Commit**

```bash
git add src/files/file-manager.ts tests/files.test.ts
git commit -m "fix: require overwrite confirmation when rename() would clobber an existing file

rename() only gated on the 'rename' confirmation kind and never checked
whether the destination already existed, so it silently overwrote an
existing file even under the default policy that mandatorily requires
'overwrite' confirmation for the equivalent write() call."
```

---

## Task M3: `file-manager.ts` — fix `list()`'s ignore-pattern root mismatch

**Files:**
- Modify: `src/files/file-manager.ts:136-163` (`list()`/`walk()`)
- Test: `tests/files.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("list() applies ignore_patterns relative to the confinement root, not the queried directory", async () => {
  const fm = /* construct with ignore_patterns: ["secrets/*.key"] and a confined root */;
  await fm.write("secrets/api.key", "sekrit", { confirmed: true });
  await fm.write("secrets/readme.md", "not secret", { confirmed: true });
  const entries = await fm.list("secrets");
  expect(entries).not.toContain("api.key");
  expect(entries).toContain("readme.md");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/files.test.ts -t "confinement root, not the queried directory"`
Expected: FAIL — `entries` currently contains `"api.key"`.

- [ ] **Step 3: Fix `list()`/`walk()`**

Current code (`src/files/file-manager.ts:136-163`):

```ts
async list(candidate: string, options: { recursive?: boolean } = {}): Promise<string[]> {
  const abs = await this.confinement.resolve(candidate);
  this.assertNotIgnored(abs, candidate);
  const recursive = options.recursive ?? false;
  const results: string[] = [];
  await this.walk(abs, abs, recursive, results);
  return results;
}

private async walk(
  root: string,
  dir: string,
  recursive: boolean,
  out: string[],
): Promise<void> {
  const entries = await this.io(dir, () => readdir(dir, { withFileTypes: true }), {
    notFound: `directory not found: ${dir}`,
  });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (isIgnored(rel, this.ignorePatterns)) continue;
    out.push(rel);
    if (recursive && entry.isDirectory()) {
      await this.walk(root, full, true, out);
    }
  }
}
```

The bug is `walk(abs, abs, ...)` passing the *queried directory* as `root`. Fix by passing the confinement root instead, matching what `assertNotIgnored`/`containingRoot` already use, and keeping the returned paths relative to the queried directory (unchanged external behavior) by computing the ignore-check path separately from the returned path:

```ts
async list(candidate: string, options: { recursive?: boolean } = {}): Promise<string[]> {
  const abs = await this.confinement.resolve(candidate);
  this.assertNotIgnored(abs, candidate);
  const recursive = options.recursive ?? false;
  const confinementRoot = this.containingRoot(abs) ?? abs;
  const results: string[] = [];
  await this.walk(confinementRoot, abs, abs, recursive, results);
  return results;
}

private async walk(
  confinementRoot: string,
  listRoot: string,
  dir: string,
  recursive: boolean,
  out: string[],
): Promise<void> {
  const entries = await this.io(dir, () => readdir(dir, { withFileTypes: true }), {
    notFound: `directory not found: ${dir}`,
  });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const ignoreRel = path.relative(confinementRoot, full);
    if (isIgnored(ignoreRel, this.ignorePatterns)) continue;
    const listRel = path.relative(listRoot, full);
    out.push(listRel);
    if (recursive && entry.isDirectory()) {
      await this.walk(confinementRoot, listRoot, full, true, out);
    }
  }
}
```

This keeps the returned entry paths relative to the *queried* directory (so `list("secrets")` still returns `"readme.md"`, not `"secrets/readme.md"` — no change to the public return-value contract), while checking ignore patterns against the confinement root, matching every other operation in the class.

- [ ] **Step 4: Run to verify it passes, then the full suite**

Run: `npx vitest run tests/files.test.ts` then `npm run typecheck && npm test`
Expected: PASS. Check any existing `list()` test with `recursive: true` still returns the same relative paths as before (the fix only changes which root is used for the ignore check, not the returned path shape).

- [ ] **Step 5: Commit**

```bash
git add src/files/file-manager.ts tests/files.test.ts
git commit -m "fix: list() now applies ignore_patterns against the confinement root

walk() computed the ignore-match path relative to the queried directory
itself, while every other operation (read/write/delete) computes it
relative to the confinement root -- so a pattern like 'secrets/*.key'
correctly blocked read('secrets/api.key') but a direct list('secrets')
still returned the excluded filename."
```

---

## Task M4: `file-manager.ts` — re-resolve paths through `PathConfinement` on undo

**Files:**
- Modify: `src/files/file-manager.ts:413-442` (`reverse()`)
- Test: `tests/files.test.ts`

**Note:** this task depends on nothing else in this plan, but pairs naturally with Task M5 (same method) — consider doing them together in one review pass, though they should still be separate commits since a reviewer could reasonably accept one and want more discussion on the other.

- [ ] **Step 1: Write the failing test**

This needs a real filesystem to create a symlink (the confinement/journal tests in this repo appear to use `mkdtemp`-based real directories, not the injectable `realpath`/`stat` used only by `sandbox.test.ts`'s unit tests — check `tests/files.test.ts`'s existing setup for the pattern). Add a second confined root (or a directory outside the confined root) to symlink to:

```ts
it("undo re-checks confinement, refusing to follow a symlink swapped in after the original mutation", async () => {
  const { fm, root } = /* construct with a single allowed root `root`, per this file's existing helper */;
  const outsideDir = await mkdtemp(path.join(tmpdir(), "sandy-outside-"));
  tmpDirs.push(outsideDir); // reuse this file's existing cleanup array if present

  await fm.write("link-target.txt", "original content", { confirmed: true });
  // Swap the file for a symlink pointing outside the confined root before undo runs.
  await rm(path.join(root, "link-target.txt"));
  await symlink(outsideDir, path.join(root, "link-target.txt"));

  await expect(fm.undo()).rejects.toThrow(); // must not silently write outside `root`
  const leaked = await stat(path.join(outsideDir, "should-not-exist")).catch(() => null);
  expect(leaked).toBeNull();
});
```

Add `symlink` to the `node:fs/promises` import at the top of `tests/files.test.ts` if not already imported. Adjust to match this file's actual fixture-construction helper names (read the top of the file first).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/files.test.ts -t "re-checks confinement"`
Expected: FAIL — today `reverse()` follows the symlink with no error.

- [ ] **Step 3: Fix `reverse()`**

Current code (`src/files/file-manager.ts:413-442`):

```ts
private async reverse(record: MutationRecord): Promise<void> {
  switch (record.op) {
    case "create-file":
      await this.rmSafe(record.path);
      break;
    case "write-file":
      if (record.before === null) await this.rmSafe(record.path);
      else await writeFile(record.path, record.before as string, "utf8");
      break;
    case "delete-file":
      if (record.before !== null) {
        await mkdir(path.dirname(record.path), { recursive: true });
        await writeFile(record.path, record.before as string, "utf8");
      }
      break;
    case "create-directory":
      await rm(record.path, { recursive: true });
      break;
    case "delete-directory": {
      const snapshot = record.before as SubtreeSnapshot | null;
      if (snapshot) {
        await restoreDirectory(record.path, snapshot);
      }
      break;
    }
    case "rename":
      if (record.to) await rename(record.to, record.path);
      break;
  }
}
```

Re-resolve every path through `this.confinement.resolve()` before touching it, so undo gets the same symlink-escape protection every live mutation gets:

```ts
private async reverse(record: MutationRecord): Promise<void> {
  const target = await this.confinement.resolve(record.path);
  switch (record.op) {
    case "create-file":
      await this.rmSafe(target);
      break;
    case "write-file":
      if (record.before === null) await this.rmSafe(target);
      else await writeFile(target, record.before as string, "utf8");
      break;
    case "delete-file":
      if (record.before !== null) {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, record.before as string, "utf8");
      }
      break;
    case "create-directory":
      await rm(target, { recursive: true });
      break;
    case "delete-directory": {
      const snapshot = record.before as SubtreeSnapshot | null;
      if (snapshot) {
        await restoreDirectory(target, snapshot);
      }
      break;
    }
    case "rename":
      if (record.to) {
        const to = await this.confinement.resolve(record.to);
        await rename(to, target);
      }
      break;
  }
}
```

`record.path`/`record.to` are already absolute, confined paths from when the mutation originally ran — `PathConfinement.resolve()` accepts absolute paths (see its doc comment: "absolute path, or relative to the primary root"), so passing them back through it costs nothing when nothing has changed on disk, and refuses the operation (throwing `SandboxViolationError`) when a symlink now diverts them outside the declared roots.

- [ ] **Step 4: Run to verify it passes, then the full suite**

Run: `npx vitest run tests/files.test.ts` then `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/files/file-manager.ts tests/files.test.ts
git commit -m "fix: re-resolve paths through PathConfinement during undo (TOCTOU symlink escape)

reverse() wrote/deleted/renamed using the raw path stored in the journal
record via bare fs calls, skipping the real-path/symlink-escape check
every live mutation gets from PathConfinement.resolve(). A path swapped
for a symlink between the original mutation and a later undo() in the
same session could redirect the reversal outside the confined root."
```

---

## Task M5: `file-manager.ts` — audit undo operations

**Files:**
- Modify: `src/files/file-manager.ts` (`undo()` at line 116, or `reverse()` — see below for which)
- Test: `tests/files.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("undo() produces an audit record", async () => {
  const { fm, audit } = /* construct with an injectable/inspectable FileAuditSink, per this file's existing pattern (or wrap NullFileAuditSink with a recording spy if no such fixture exists yet) */;
  await fm.write("a.txt", "hello", { confirmed: true });
  const before = audit.records.length; // adjust to whatever the actual spy/audit fixture exposes
  await fm.undo();
  expect(audit.records.length).toBe(before + 1);
  expect(audit.records.at(-1)?.op).toBe("undo");
});
```

If `tests/files.test.ts` doesn't already have an audit-recording test double, add a minimal one at the top of the file:

```ts
class RecordingAuditSink implements FileAuditSink {
  records: Array<{ op: string; path: string; outcome: "ok" | "error"; error?: string; dryRun?: boolean }> = [];
  record(entry: { op: string; path: string; at: string; outcome: "ok" | "error"; error?: string; dryRun?: boolean }): void {
    this.records.push(entry);
  }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/files.test.ts -t "undo() produces an audit record"`
Expected: FAIL — today `undo()`/`reverse()` never call `this.audit.record(...)`.

- [ ] **Step 3: Add the audit call**

`reverse()` is a private method with no return value describing what happened, and it's invoked by `InMemoryJournal.undo()` via the `ReverseMutation` callback (`src/files/journal.ts`), not directly by `FileManager.undo()`. The cleanest place to add the audit call is in `FileManager.undo()` itself (`src/files/file-manager.ts:115-118`), since that's where the `FileManager` (which owns `this.audit`) knows the operation completed:

Current code:

```ts
/** Undo the last journaled mutation (FM-05). Resolves undefined if none. */
undo(): Promise<MutationRecord | undefined> {
  return this.journal.undo().then((r) => r?.undone);
}
```

Replace with:

```ts
/** Undo the last journaled mutation (FM-05). Resolves undefined if none. */
async undo(): Promise<MutationRecord | undefined> {
  const result = await this.journal.undo();
  if (!result) return undefined;
  this.audit.record({
    op: `undo(${result.undone.op})`,
    path: result.undone.path,
    at: new Date().toISOString(),
    outcome: "ok",
  });
  return result.undone;
}
```

This records success only (matching this method's current contract — `journal.undo()`'s `reverse` callback throwing propagates as a rejection, so a failed undo already surfaces as a thrown error to the caller; if you want a failure audit record too, wrap in try/catch and record `outcome: "error"` before rethrowing — do this if the review of this task calls for symmetry with the forward-mutation methods, which do record `io-error` on failure via the shared `io()` helper).

- [ ] **Step 4: Run to verify it passes, then the full suite**

Run: `npx vitest run tests/files.test.ts` then `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/files/file-manager.ts tests/files.test.ts
git commit -m "fix: audit undo operations

Every forward mutation (write/delete/mkdir/rename) records an audit
entry; undo() reversed them on disk with no corresponding entry,
breaking the append-only 'every mutation is journaled and audited'
(AU-01) invariant for exactly the operation most likely to need
forensic scrutiny."
```

---

## Task M6: `file-manager.ts` — make `deleteDirectory()`'s dry-run decision consistent

**Files:**
- Modify: `src/files/file-manager.ts:328-366` (`deleteDirectory()`)
- Test: `tests/files.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("deleteDirectory() does not snapshot when policy.dry_run_default is true and dryRun is unspecified", async () => {
  const { fm } = /* construct with policy.dry_run_default: true */;
  await fm.write("big/one.txt", "x", { confirmed: true });
  let snapshotCalls = 0;
  // If the test file already has a way to spy on fs reads, use it; otherwise
  // assert indirectly: the operation must complete without error even if a
  // file in the tree is made unreadable, since a true dry run must never
  // touch file contents.
  await fs.chmod(path.join(root, "big/one.txt"), 0o000); // simulate an unreadable file
  const result = await fm.deleteDirectory("big", { confirmed: true }); // dryRun intentionally omitted
  expect(result.applied).toBe(false); // policy default made this a dry run
  await fs.chmod(path.join(root, "big/one.txt"), 0o644); // restore for cleanup
});
```

(Adjust to whatever permission/spy mechanism is practical in this test environment — the key assertion is that an unreadable file inside the subtree must not make a true dry-run call throw.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/files.test.ts -t "does not snapshot when policy.dry_run_default"`
Expected: FAIL — `snapshotDirectory()` runs and throws on the unreadable file even though the call is really a dry run.

- [ ] **Step 3: Fix `deleteDirectory()`**

Current code (`src/files/file-manager.ts:352-357`):

```ts
this.requireConfirmation("delete", candidate, `delete directory ${abs} and all of its contents`, options);

const snapshot = dryRunOf(options)
  ? null
  : await snapshotDirectory(abs);

const dryRun = options.dryRun ?? this.policy.dry_run_default;
```

Replace with a single, consistently-computed `dryRun` used for both decisions:

```ts
this.requireConfirmation("delete", candidate, `delete directory ${abs} and all of its contents`, options);

const dryRun = options.dryRun ?? this.policy.dry_run_default;
const snapshot = dryRun ? null : await snapshotDirectory(abs);
```

Remove the now-unused `dryRunOf()` helper function at the bottom of the file (`src/files/file-manager.ts:449-451`) if this was its only call site — check with `grep -n "dryRunOf" src/files/file-manager.ts` first.

- [ ] **Step 4: Run to verify it passes, then the full suite**

Run: `npx vitest run tests/files.test.ts` then `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/files/file-manager.ts tests/files.test.ts
git commit -m "fix: deleteDirectory() uses one consistent dry-run decision

The snapshot decision and the actual-delete decision used two different
dry-run expressions (options.dryRun ?? false vs. options.dryRun ??
policy.dry_run_default), so when dryRun was unset and dry_run_default was
true, a supposedly no-op dry run still did a full recursive read of the
subtree -- wasted I/O, and a hard failure if any file was unreadable."
```

---

## Task M7: `file-manager.ts` — preserve exact bytes for undo (fix binary-file corruption)

**Files:**
- Modify: `src/files/file-manager.ts` — `write()` (prior-content capture), `deleteFile()` (prior-content capture), `reverse()` (`write-file`/`delete-file` cases), `snapshotDirectory()`/`restoreDirectory()`
- Test: `tests/files.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("undo restores a pre-existing binary file byte-for-byte, not corrupted through UTF-8", async () => {
  const { fm, root } = /* construct */;
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01]); // not valid UTF-8
  await writeFile(path.join(root, "image.png"), binary); // written directly to disk, bypassing FileManager (it's "pre-existing" content, not something Sandy wrote)
  await fm.deleteFile("image.png", { confirmed: true });
  await fm.undo();
  const restored = await readFile(path.join(root, "image.png"));
  expect(restored.equals(binary)).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/files.test.ts -t "byte-for-byte"`
Expected: FAIL — `restored.equals(binary)` is `false` because the bytes were mangled through a UTF-8 round-trip.

- [ ] **Step 3: Fix the prior-content capture and restoration to be byte-exact**

Change every place that captures "before" content for undo to base64-encode the raw bytes instead of decoding as UTF-8, and every place that restores it to decode from base64 back to a `Buffer` (never re-encoding as UTF-8 text). This affects four spots in `src/files/file-manager.ts`:

In `write()` (currently around line 186):

```ts
priorContent = await readFile(abs, "utf8");
```
→
```ts
priorContent = (await readFile(abs)).toString("base64");
```

In `deleteFile()` (currently around line 229):

```ts
priorContent = await readFile(abs, "utf8");
```
→
```ts
priorContent = (await readFile(abs)).toString("base64");
```

In `snapshotDirectory()` (currently around line 469):

```ts
} else if (entry.isFile()) {
  snapshot.files.push({ rel, content: await readFile(full, "utf8") });
}
```
→
```ts
} else if (entry.isFile()) {
  snapshot.files.push({ rel, content: (await readFile(full)).toString("base64") });
}
```

In `reverse()`'s `write-file` and `delete-file` cases:

```ts
case "write-file":
  if (record.before === null) await this.rmSafe(target);
  else await writeFile(target, record.before as string, "utf8");
  break;
case "delete-file":
  if (record.before !== null) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, record.before as string, "utf8");
  }
  break;
```
→
```ts
case "write-file":
  if (record.before === null) await this.rmSafe(target);
  else await writeFile(target, Buffer.from(record.before as string, "base64"));
  break;
case "delete-file":
  if (record.before !== null) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(record.before as string, "base64"));
  }
  break;
```

In `restoreDirectory()` (currently around line 477-486):

```ts
for (const file of snapshot.files) {
  const full = path.join(root, file.rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, file.content, "utf8");
}
```
→
```ts
for (const file of snapshot.files) {
  const full = path.join(root, file.rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, Buffer.from(file.content, "base64"));
}
```

Note: the `after` field for `write-file`/`create-file` records (the content Sandy itself wrote via `write(candidate, content: string, ...)`) is unaffected by this task — it's always genuine text content coming from the `write()` API's own `content: string` parameter, never read back off disk, so it stays a plain string. Only "before" snapshots of content that already existed on disk (which could be anything) need the byte-exact treatment.

- [ ] **Step 4: Run to verify it passes, then the full suite**

Run: `npx vitest run tests/files.test.ts` then `npm run typecheck && npm test`
Expected: PASS. Also re-run the M4 symlink test and the M5 audit test from earlier tasks if done in the same branch, to confirm no interaction.

- [ ] **Step 5: Commit**

```bash
git add src/files/file-manager.ts tests/files.test.ts
git commit -m "fix: preserve exact bytes for undo of pre-existing binary files

write()/deleteFile()/snapshotDirectory() captured 'before' content via
readFile(path, 'utf8'), which lossily mangles any pre-existing binary
file (image, PDF, archive) under the sandbox root through a UTF-8
round-trip. Undo of such a mutation silently corrupted the restored
bytes. Prior content is now captured/restored as base64-encoded raw
bytes, byte-exact regardless of content type."
```

---

## Task M8: `engine.ts` — kill the child process before treating an invocation failure as degraded

**Files:**
- Modify: `src/engine.ts:476-487` (`LlamaCppEngine.invoke()` catch block)
- Test: `tests/engine.test.ts`

- [ ] **Step 1: Write the failing test**

Using this file's existing fake-`spawnFactory`/fake-`fetchImpl` injection pattern (see the existing `LlamaCppEngine` tests for the exact fixture shape — a fake `ChildProcess` with a `kill` spy is what's needed here):

```ts
it("invoke() kills the child process when the request fails, so the next start() does not orphan it", async () => {
  const killSpy = vi.fn();
  const fakeChild = /* this file's existing fake ChildProcess builder, with kill: killSpy */;
  const engine = new LlamaCppEngine({
    audit: new InMemoryAuditLogger(),
    modelPath: /* an existing fixture path this file already uses for "file exists" */,
    model: "test-model",
    spawnFactory: () => fakeChild,
    fetchImpl: /* one that resolves /health then rejects the chat-completions call, per this file's existing helpers */,
  });
  await engine.start();
  await expect(engine.invoke({ prompt: "hi" })).rejects.toThrow();
  expect(killSpy).toHaveBeenCalledWith("SIGTERM");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/engine.test.ts -t "does not orphan it"`
Expected: FAIL — `killSpy` is never called today.

- [ ] **Step 3: Fix the catch block**

Current code (`src/engine.ts:476-487`):

```ts
} catch (err) {
  this.record({
    inputTokens: undefined,
    outputTokens: undefined,
    durationMs: this.now() - started,
    outcome: "error",
    error: (err as Error).message,
  });
  this.state = "degraded";
  this.detail = (err as Error).message;
  throw err;
}
```

Add a call to the existing `killChild()` helper before marking degraded, and reset `this.state` to `"not-started"` after killing so the next `start()` cleanly re-spawns rather than trying to reuse a half-torn-down state:

```ts
} catch (err) {
  this.record({
    inputTokens: undefined,
    outputTokens: undefined,
    durationMs: this.now() - started,
    outcome: "error",
    error: (err as Error).message,
  });
  // A failed invocation may have left the server in a bad state (or just
  // timed out mid-request) -- kill it rather than leaving it running while
  // we report degraded, so the next start() doesn't leak this process when
  // it spawns a replacement.
  await this.killChild();
  this.state = "degraded";
  this.detail = (err as Error).message;
  throw err;
}
```

`killChild()` already exists (`src/engine.ts:497-520`) and is idempotent/safe to call on an already-dead or already-null child, so no other changes are needed — `doStart()`'s `this.child = this.spawnFactory(...)` on the next `start()` now always replaces a `null` child (set by `killChild()`), never a still-live one.

- [ ] **Step 4: Run to verify it passes, then the full suite**

Run: `npx vitest run tests/engine.test.ts` then `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts tests/engine.test.ts
git commit -m "fix: kill the model server child process on a failed invocation

invoke()'s catch block marked the engine degraded without killing the
still-running llama-server process; the next start() spawned a
replacement and silently overwrote the reference to the orphaned one.
Repeated timeouts/failures leaked one model-server process each."
```

---

## Task M9: `orchestrator.ts` — don't discard gathered claims/gaps when the report write fails

**Files:**
- Modify: `src/orchestrator/orchestrator.ts:74-81` (`OrchestratorResult` interface), `:226-249` (`run()`)
- Test: `tests/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("run() returns already-gathered claims/gaps even if the report write fails", async () => {
  const { orchestrator } = /* construct per this file's existing pattern, with a real gather task that succeeds */;
  const result = await orchestrator.run({
    goal: "test",
    gather: [{ id: "t1", server: "crm", tool: "read_deals", args: {} }],
    report: { file: "summary.json" }, // wrong extension for the always-Markdown renderer
  });
  expect(result.claims.length).toBeGreaterThan(0); // must not be lost
  expect(result.reportPath).toBeUndefined();
  expect(result.reportError).toBeDefined();
});
```

(Match this file's existing fixture pattern for a real `Orchestrator` wired to a real `FileManager`/temp confined root — several existing tests in the file already write real reports to a temp dir.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts -t "report write fails"`
Expected: FAIL — today `run()`'s returned promise rejects instead of resolving, so `result` is never assigned and the whole test throws.

- [ ] **Step 3: Add `reportError` to `OrchestratorResult` and catch the write**

Current interface (`src/orchestrator/orchestrator.ts:74-81`):

```ts
export interface OrchestratorResult {
  goal: string;
  claims: Claim[];
  gaps: Gap[];
  reportPath?: string;
  reportContent?: string;
  transcript: Transcript;
}
```

Add `reportError`:

```ts
export interface OrchestratorResult {
  goal: string;
  claims: Claim[];
  gaps: Gap[];
  reportPath?: string;
  reportContent?: string;
  /** Set when report rendering succeeded but writing it to disk failed
   *  (e.g. a format/extension mismatch) -- claims/gaps are still returned. */
  reportError?: string;
  transcript: Transcript;
}
```

Current code (`src/orchestrator/orchestrator.ts:226-243`):

```ts
let reportPath: string | undefined;
let reportContent: string | undefined;
if (request.report) {
  const generatedAt = new Date().toISOString();
  reportContent = this.renderReport({
    goal: request.goal,
    title: request.report.title ?? request.goal,
    claims,
    gaps,
    generatedAt,
    summary: request.report.summary,
  });
  const file = request.report.file ?? `report-${Date.now()}.md`;
  this.onProgress({ type: "report-writing", path: file });
  if (this.writeReport) {
    reportPath = await this.writeReport(reportContent, file);
  }
}
```

Wrap the write in try/catch, audit the failure, and keep `reportContent` (the rendered text) available to the caller even when the disk write failed:

```ts
let reportPath: string | undefined;
let reportContent: string | undefined;
let reportError: string | undefined;
if (request.report) {
  const generatedAt = new Date().toISOString();
  reportContent = this.renderReport({
    goal: request.goal,
    title: request.report.title ?? request.goal,
    claims,
    gaps,
    generatedAt,
    summary: request.report.summary,
  });
  const file = request.report.file ?? `report-${Date.now()}.md`;
  this.onProgress({ type: "report-writing", path: file });
  if (this.writeReport) {
    try {
      reportPath = await this.writeReport(reportContent, file);
    } catch (err) {
      reportError = err instanceof Error ? err.message : String(err);
      this.audit.append("orchestrator_task", {
        task: "report-write",
        server: "sandy",
        tool: "write-report",
        outcome: "error",
        error: reportError,
      });
    }
  }
}
```

Update the return statement (`src/orchestrator/orchestrator.ts:248`) to include `reportError`:

```ts
return { goal: request.goal, claims, gaps, reportPath, reportContent, reportError, transcript: captureTranscript(this.audit) };
```

- [ ] **Step 4: Check callers that assume `run()` never rejects for a report-write reason**

Grep `grep -rn "\.run(" src/cli.ts src/plugin/api.ts src/standalone/loop.ts` and confirm none of them specifically catch a report-write failure as a special case (they shouldn't need to — they just stop unconditionally throwing here). `src/standalone/loop.ts`'s `AutonomousLoop.run()` checks `result.reportPath && result.reportContent` before narrating (`src/standalone/loop.ts:233`) — this already correctly skips narration when there's no `reportPath`, so no change needed there; a `reportError` on the result just means narration is skipped this run, which is correct (there's no successfully-written report to re-render into).

- [ ] **Step 5: Run to verify it passes, then the full suite**

Run: `npx vitest run tests/orchestrator.test.ts tests/loop.test.ts` then `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/orchestrator.ts tests/orchestrator.test.ts
git commit -m "fix: don't discard gathered claims/gaps when the report write fails

request.report.file accepts any extension with no restriction, but the
renderer always produces Markdown -- a non-markdown extension (e.g.
'summary.json') made FileManager.write()'s format validation throw
uncaught out of run(), discarding every already-gathered claim and gap.
The write is now caught; a new optional reportError field on
OrchestratorResult surfaces the failure while claims/gaps are preserved."
```

---

## Task M10: `plugin/state.ts` — fix the `SessionCache.get()` check-then-act race

**Files:**
- Modify: `src/plugin/state.ts:94-108` (`SessionCache.get()`)
- Test: `tests/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("get() called concurrently for the same config path returns the same session and builds Sandy only once", async () => {
  const cache = /* construct per this file's existing pattern */;
  const [a, b] = await Promise.all([cache.get(cfgPath), cache.get(cfgPath)]);
  expect(a).toBe(b);
  expect(cache.size).toBe(1);
});
```

(If `createSandy` isn't already trivially callable twice in this test's fixture without side effects like binding ports, use this file's existing transportFactory/injectable pattern so a double-create is observable without actually needing two real MCP connections.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/plugin.test.ts -t "builds Sandy only once"`
Expected: FAIL — today `a !== b` is possible (whichever `createSandy` call's `.then` runs last wins the `sessions.set`), and depending on timing `cache.size` could still read `1` while having actually constructed two `Sandy` instances (the assertion on `a === b` is the one that reliably catches it).

- [ ] **Step 3: Fix `get()` to reserve the slot synchronously with an in-flight promise**

Current code (`src/plugin/state.ts:94-108`):

```ts
async get(configPath: string): Promise<PluginSession> {
  const resolved = path.resolve(configPath);
  const existing = this.sessions.get(resolved);
  if (existing) return existing;

  const progress = new ProgressCollector();
  const sandy = await createSandy({
    ...this.options,
    sandyPath: resolved,
    onProgress: progress.sink,
  });
  const session: PluginSession = { sandy, configPath: resolved, progress };
  this.sessions.set(resolved, session);
  return session;
}
```

Replace the `Map<string, PluginSession>` with a `Map<string, Promise<PluginSession>>` so the *promise itself* is reserved synchronously before any `await`, closing the race:

```ts
export class SessionCache {
  private readonly sessions = new Map<string, Promise<PluginSession>>();

  constructor(private readonly options: SandyPluginOptions) {}

  get size(): number {
    return this.sessions.size;
  }

  get(configPath: string): Promise<PluginSession> {
    const resolved = path.resolve(configPath);
    const existing = this.sessions.get(resolved);
    if (existing) return existing;

    const progress = new ProgressCollector();
    const sessionPromise = createSandy({
      ...this.options,
      sandyPath: resolved,
      onProgress: progress.sink,
    }).then((sandy) => ({ sandy, configPath: resolved, progress }));
    this.sessions.set(resolved, sessionPromise);
    // If construction fails, don't leave a permanently-broken entry cached --
    // let a later call retry from scratch.
    sessionPromise.catch(() => this.sessions.delete(resolved));
    return sessionPromise;
  }

  async closeAll(): Promise<void> {
    const pending = [...this.sessions.values()];
    this.sessions.clear();
    const sessions = await Promise.allSettled(pending);
    await Promise.all(
      sessions
        .filter((r): r is PromiseFulfilledResult<PluginSession> => r.status === "fulfilled")
        .map((r) => r.value.sandy.close()),
    );
  }
}
```

Note `get()` is no longer declared `async` — it now synchronously returns the (possibly already-settled, possibly still-pending) promise from the map, which is what makes the second concurrent caller see the *same* in-flight promise instead of racing past an empty check. Callers awaiting `cache.get(...)` see no change in behavior for the non-concurrent case.

- [ ] **Step 4: Run to verify it passes, then the full suite**

Run: `npx vitest run tests/plugin.test.ts` then `npm run typecheck && npm test`
Expected: PASS. Check `src/plugin/mcp-server.ts:156` (`const session = await cache.get(configPath);`) and any other `cache.get(...)` call sites still type-check against the new signature (they should — `await`ing a `Promise<PluginSession>` works identically whether `get` itself is `async` or just returns a promise directly).

- [ ] **Step 5: Commit**

```bash
git add src/plugin/state.ts tests/plugin.test.ts
git commit -m "fix: close SessionCache.get()'s check-then-act race

Two concurrent calls for the same config path could both miss the cache
before the first createSandy() resolved, each building a full Sandy
instance; the second sessions.set() silently clobbered the first, which
was then never closed by closeAll(). The cache now stores the in-flight
promise itself (reserved synchronously before any await), so a second
concurrent caller sees and awaits the same construction."
```

---

## Task M11: `standalone/api.ts` — explicit Origin check + reject non-JSON content types

**Files:**
- Modify: `src/standalone/api.ts:391-406` (`readJsonBody()`), `:440-451` (`handleRequest()` — add the Origin check at the top)
- Test: `tests/standalone-api.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("rejects a POST with a non-application/json Content-Type (closes the CORS-simple-request bypass)", async () => {
  const { api } = /* construct per this file's existing pattern */;
  const res = await fetch(`http://${api.boundHost}:${api.boundPort}/run`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ goal: "x", gather: [{ id: "t", server: "s", tool: "t", args: {} }] }),
  });
  expect(res.status).toBe(415);
});

it("rejects a POST carrying a foreign Origin header", async () => {
  const { api } = /* construct */;
  const res = await fetch(`http://${api.boundHost}:${api.boundPort}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example.com" },
    body: JSON.stringify({ goal: "x", gather: [{ id: "t", server: "s", tool: "t", args: {} }] }),
  });
  expect(res.status).toBe(403);
});

it("still accepts a same-origin (or Origin-less) POST with application/json", async () => {
  const { api } = /* construct */;
  const res = await fetch(`http://${api.boundHost}:${api.boundPort}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "x", gather: [{ id: "t", server: "s", tool: "t", args: {} }] }),
  });
  expect(res.status).toBe(202);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/standalone-api.test.ts -t "Origin\|Content-Type\|CORS"`
Expected: FAIL (415/403 cases return 202 today; the pass-through case may already pass).

- [ ] **Step 3: Add the checks to `handleRequest`**

Current top of `handleRequest` (`src/standalone/api.ts:440-450`):

```ts
async function handleRequest(
  api: LocalApi,
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean); // e.g. ["jobs","job-1","events"]

  // GET /health
  if (method === "GET" && url.pathname === "/health") {
```

Add an Origin check immediately after computing `method`, before any route matching, rejecting any request that carries a foreign `Origin` header (a legitimate local CLI/tool client never sets one; only a browser does, and only a same-origin or absent Origin is trusted):

```ts
async function handleRequest(
  api: LocalApi,
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean); // e.g. ["jobs","job-1","events"]

  // Defense in depth against a browser-originated cross-origin request: a
  // legitimate local caller (curl, the Sandy CLI, a Node script) never sends
  // an Origin header at all; only a browser does. This API is loopback-only
  // and unauthenticated by design (SD-03), so an Origin header from anywhere
  // other than this server's own bound address is refused outright, rather
  // than relying solely on the browser's CORS-preflight behavior for
  // requests whose Content-Type happens to require one.
  const origin = req.headers.origin;
  if (typeof origin === "string") {
    const selfOrigin = `http://${req.headers.host ?? ""}`;
    if (origin !== selfOrigin) {
      send(res, 403, { error: "cross-origin requests are not permitted" });
      return;
    }
  }

  // GET /health
  if (method === "GET" && url.pathname === "/health") {
```

Then in `readJsonBody` (`src/standalone/api.ts:391-406`), require `application/json` for any non-empty body, closing the CORS-simple-request bypass (a JSON `Content-Type` forces a browser to preflight, which this server never grants via `Access-Control-Allow-Origin`, so a genuine cross-origin browser request can no longer reach here at all — the Origin check above is the second, independent layer):

Current code:

```ts
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new ApiError(413, `request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new ApiError(400, `request body is not valid JSON: ${(err as Error).message}`);
  }
}
```

Add a content-type check at the top:

```ts
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = req.headers["content-type"];
  if (contentType !== undefined && !contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, `unsupported content-type "${contentType}"; expected application/json`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new ApiError(413, `request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new ApiError(400, `request body is not valid JSON: ${(err as Error).message}`);
  }
}
```

The call site in `handleRequest` (`POST /run`, `POST /ask`) already wraps `readJsonBody` in a try/catch that converts an `ApiError` to the right HTTP status (`src/standalone/api.ts:479-487`), so a 415 from this new check is automatically surfaced correctly with no further changes needed there.

- [ ] **Step 4: Run to verify they pass, then the full suite**

Run: `npx vitest run tests/standalone-api.test.ts` then `npm run typecheck && npm test`
Expected: PASS. Double-check no existing test sends a request with a non-`application/json` content-type or a foreign `Origin` header expecting success — if one does, it was relying on the gap this task closes and should be updated to send `application/json` / no Origin.

- [ ] **Step 5: Commit**

```bash
git add src/standalone/api.ts tests/standalone-api.test.ts
git commit -m "security: reject cross-origin and non-JSON requests to the local API

readJsonBody() ignored Content-Type entirely, so a cross-origin browser
request using a CORS-simple content type (e.g. text/plain) could reach
POST /run and POST /ask with no preflight and no same-origin check --
letting any webpage open in the user's browser drive the loopback API.
Now requires application/json (forcing a preflight the server never
grants) and independently rejects any request carrying a foreign Origin
header, as defense in depth for a service that is unauthenticated by
design (SD-03)."
```

---

## Task M12: `scripts/provision-model.sh` — verify the `llama-server` binary's integrity

**Files:**
- Modify: `scripts/provision-model.sh`
- Modify: `docs/MODEL.md` (document the new pin, matching how the model's pin is already documented there)

- [ ] **Step 1: Obtain the real SHA256 of the currently-pinned llama.cpp release+variant**

This step requires network access (to download the exact artifact the script already points at) — run it for real, don't fabricate the value:

```bash
curl -fsSL -o /tmp/llama-verify.tar.gz \
  "https://github.com/ggml-org/llama.cpp/releases/download/b10569/llama-b10569-bin-ubuntu-vulkan-x64.tar.gz"
sha256sum /tmp/llama-verify.tar.gz
```

Take the printed hash — this is the real value for `DEFAULT_LLAMA_SHA256` in Step 2. (If the pinned `LLAMA_RELEASE`/`LLAMA_VARIANT` in the script have moved on by the time this task is executed, bump them first per whatever the current documented default is, then compute the hash for the release actually being pinned.)

- [ ] **Step 2: Add the pin and verification to the script**

Current code (`scripts/provision-model.sh`, the variable block near the top):

```bash
DEFAULT_MODEL_URL="https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
DEFAULT_MODEL_SHA256="3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597"
DEFAULT_MODEL_FILE="Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
LLAMA_RELEASE="${SANDY_LLAMA_RELEASE:-b10569}"
LLAMA_VARIANT="${SANDY_LLM_VARIANT:-ubuntu-vulkan-x64}"   # vulkan = GPU, no CUDA toolkit
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/llama-${LLAMA_RELEASE}-bin-${LLAMA_VARIANT}.tar.gz"
LLAMA_EXTRACT_DIR="llama-${LLAMA_RELEASE}"
```

Add a pinned default hash for the default release+variant, matching the model's existing pattern:

```bash
DEFAULT_MODEL_URL="https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
DEFAULT_MODEL_SHA256="3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597"
DEFAULT_MODEL_FILE="Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
LLAMA_RELEASE="${SANDY_LLAMA_RELEASE:-b10569}"
LLAMA_VARIANT="${SANDY_LLM_VARIANT:-ubuntu-vulkan-x64}"   # vulkan = GPU, no CUDA toolkit
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/llama-${LLAMA_RELEASE}-bin-${LLAMA_VARIANT}.tar.gz"
LLAMA_EXTRACT_DIR="llama-${LLAMA_RELEASE}"
# SHA256 of the default (release, variant) pin above -- pinned the same way the
# model is, since this tarball becomes executable code we chmod +x and run.
DEFAULT_LLAMA_SHA256="<the value printed by Step 1 -- fill in before merging this change>"
LLAMA_SHA256="${SANDY_LLAMA_SHA256:-$DEFAULT_LLAMA_SHA256}"
```

Then in the download section, add verification before extraction. Current code:

```bash
# --- 1. llama-server (the local model runtime) -------------------------------
log "downloading llama.cpp ${LLAMA_RELEASE} (${LLAMA_VARIANT})"
curl -fsSL --max-time 1200 -o "$TMP/llama.tar.gz" "$LLAMA_URL" || fail "llama.cpp download failed: $LLAMA_URL"
tar xzf "$TMP/llama.tar.gz" -C "$TMP" || fail "llama.cpp tarball is corrupt"
```

Replace with:

```bash
# --- 1. llama-server (the local model runtime) -------------------------------
log "downloading llama.cpp ${LLAMA_RELEASE} (${LLAMA_VARIANT})"
curl -fsSL --max-time 1200 -o "$TMP/llama.tar.gz" "$LLAMA_URL" || fail "llama.cpp download failed: $LLAMA_URL"

if [ "$LLAMA_RELEASE" != "b10569" ] || [ "$LLAMA_VARIANT" != "ubuntu-vulkan-x64" ]; then
  if [ -z "${SANDY_LLAMA_SHA256:-}" ]; then
    fail "SANDY_LLAMA_RELEASE/SANDY_LLM_VARIANT was overridden from the pinned default, so the built-in DEFAULT_LLAMA_SHA256 does not apply. Set SANDY_LLAMA_SHA256 explicitly (compute it with: curl -fsSL -o /tmp/x.tar.gz '$LLAMA_URL' && sha256sum /tmp/x.tar.gz), or unset the override to use the pinned default."
  fi
fi
log "verifying llama.cpp tarball SHA256 (fail-closed; this becomes executable code)"
ACTUAL_LLAMA="$(sha256sum "$TMP/llama.tar.gz" | awk '{print $1}')"
if [ "$ACTUAL_LLAMA" != "$LLAMA_SHA256" ]; then
  fail "llama.cpp tarball hash mismatch (expected $LLAMA_SHA256, got $ACTUAL_LLAMA) — refusing to extract/run an unverified binary"
fi
log "llama.cpp tarball verified"

tar xzf "$TMP/llama.tar.gz" -C "$TMP" || fail "llama.cpp tarball is corrupt"
```

- [ ] **Step 3: Update `docs/MODEL.md`**

Read `docs/MODEL.md`'s existing section documenting the model's SHA256 pin and provisioning-override env vars, and add the equivalent for `SANDY_LLAMA_SHA256`/`DEFAULT_LLAMA_SHA256`, following the same structure/tone as the existing model-pin documentation in that file.

- [ ] **Step 4: Verify the script runs end-to-end (requires network + the target platform)**

Run: `bash scripts/provision-model.sh` on a machine with network access and confirm it completes and prints the config block, with the new "llama.cpp tarball verified" log line appearing before extraction. Then deliberately corrupt the pin (`SANDY_LLAMA_SHA256=0000000000000000000000000000000000000000000000000000000000000 bash scripts/provision-model.sh` after clearing any cached download) and confirm it fails closed with a clear message and does **not** extract/chmod/leave a runnable binary behind.

- [ ] **Step 5: Commit**

```bash
git add scripts/provision-model.sh docs/MODEL.md
git commit -m "security: verify llama-server binary integrity before executing it

The model GGUF was SHA256-pinned and verified fail-closed, but the
llama-server binary tarball -- executable code, chmod +x'd and run as a
subprocess -- had no integrity check at all. Pinned and verified the
same way the model is; a release/variant override without an explicit
SANDY_LLAMA_SHA256 now fails closed instead of silently skipping
verification."
```

---

## Task M13: `audit/logger.ts` — surface `JsonlAuditLogger` write failures instead of swallowing them

**Files:**
- Modify: `src/audit/logger.ts:100-135` (`JsonlAuditLogger`)
- Test: `tests/config.test.ts` or a new `tests/audit.test.ts` — check whether an audit-specific test file already exists (`ls tests/*.test.ts` per the repo listing shows no dedicated `audit.test.ts` today; add one, or place it in whichever existing file already imports `JsonlAuditLogger`, e.g. `tests/sandy.test.ts`).

- [ ] **Step 1: Write the failing test**

```ts
it("close() rejects if a JSONL write ever failed during the session", async () => {
  const badPath = "/nonexistent-root-dir-without-permission/audit.jsonl"; // or a path this test's platform can reliably fail to write (e.g. a directory that exists as a file, forcing mkdir to fail)
  const logger = new JsonlAuditLogger(badPath);
  logger.append("session_start", {});
  await expect(logger.close()).rejects.toThrow();
});
```

Pick a failure mode that's reliable in CI (a common trick: create a *file* at the parent path first, so `mkdir(path.dirname(filePath), { recursive: true })` fails with `ENOTDIR`) rather than relying on filesystem permissions, which behave inconsistently across CI runners:

```ts
it("close() rejects if a JSONL write ever failed during the session", async () => {
  const root = await tmpWorkspace();
  const blocker = path.join(root, "blocker"); // a FILE, not a directory
  await writeFile(blocker, "not a directory");
  const badPath = path.join(blocker, "audit.jsonl"); // mkdir(dirname(...)) will fail: ENOTDIR
  const logger = new JsonlAuditLogger(badPath);
  logger.append("session_start", {});
  await expect(logger.close()).rejects.toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run <the file> -t "rejects if a JSONL write ever failed"`
Expected: FAIL (or an unhandled rejection warning in the test runner's output, depending on Vitest's handling) — today `close()` just resolves, the write failure having vanished silently.

- [ ] **Step 3: Fix `JsonlAuditLogger`**

Current code (`src/audit/logger.ts:100-135`):

```ts
export class JsonlAuditLogger implements AuditLogger {
  private readonly memory: InMemoryAuditLogger;
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(filePath: string, options: { auditPayloadLogging?: boolean } = {}) {
    this.filePath = filePath;
    this.memory = new InMemoryAuditLogger(options);
  }

  get path(): string {
    return this.filePath;
  }

  append(type: AuditEventType, data: Record<string, unknown>, opts?: { payload?: unknown }): AuditEvent {
    const event = this.memory.append(type, data, opts);
    if (!this.closed) {
      const line = `${JSON.stringify(event)}\n`;
      this.writeChain = this.writeChain.then(async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, line, "utf8");
      });
    }
    return event;
  }

  events(): readonly AuditEvent[] {
    return this.memory.events();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain;
  }
}
```

Replace with a version that catches each write failure immediately (so it's never an unhandled rejection), logs it loudly to stderr as it happens, and remembers the first failure so `close()` surfaces it to the caller:

```ts
export class JsonlAuditLogger implements AuditLogger {
  private readonly memory: InMemoryAuditLogger;
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  private writeError: Error | undefined;

  constructor(filePath: string, options: { auditPayloadLogging?: boolean } = {}) {
    this.filePath = filePath;
    this.memory = new InMemoryAuditLogger(options);
  }

  get path(): string {
    return this.filePath;
  }

  append(type: AuditEventType, data: Record<string, unknown>, opts?: { payload?: unknown }): AuditEvent {
    const event = this.memory.append(type, data, opts);
    if (!this.closed) {
      const line = `${JSON.stringify(event)}\n`;
      this.writeChain = this.writeChain
        .then(async () => {
          await mkdir(path.dirname(this.filePath), { recursive: true });
          await appendFile(this.filePath, line, "utf8");
        })
        .catch((err) => {
          // The audit log is supposed to be a complete, reliable record --
          // a write failure must never vanish silently. Surface it loudly
          // now (stderr) and remember it so close() reports it too, rather
          // than letting this become an unhandled promise rejection.
          const wrapped = err instanceof Error ? err : new Error(String(err));
          this.writeError ??= wrapped;
          process.stderr.write(`sandy: audit log write to ${this.filePath} failed: ${wrapped.message}\n`);
        });
    }
    return event;
  }

  events(): readonly AuditEvent[] {
    return this.memory.events();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain;
    if (this.writeError) throw this.writeError;
  }
}
```

- [ ] **Step 4: Check `close()` callers for the new possible rejection**

Grep `grep -rn "\.close()" src/sandy.ts src/cli.ts` — `Sandy.close()` (`src/sandy.ts:324-330`) calls `await audit.close()` last, unguarded; this now can throw where it couldn't before. Confirm this is acceptable: the CLI's `withSandy()` helper (`src/cli.ts:315-331`) calls `sandy.close()` in a `finally` block — if `close()` now throws, that throw will propagate out of the `finally`, replacing (or chaining with, per JS semantics) whatever the `try` block returned/threw. This is the correct, intended behavior for this fix (a lost audit write should be a visible failure), but confirm no test currently asserts a clean exit code in a scenario that would now surface this — none should, since this is a new failure mode with no existing test coverage of that path.

- [ ] **Step 5: Run to verify it passes, then the full suite**

Run: `npx vitest run` (the file with the new test) then `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/audit/logger.ts <test file>
git commit -m "fix: surface JsonlAuditLogger write failures instead of swallowing them

appendFile()'s promise chain had no .catch, so a disk-full/permission
failure mid-session became an unhandled promise rejection with no
operator-visible signal -- for a component whose entire job is a
reliable audit trail, a write failure must be loud. Failures are now
logged to stderr as they happen and re-thrown from close()."
```

---

## Task M14: Document the prompt-injection threat model for the narrate step

**Files:**
- Modify: `docs/PHASE2_DESIGN.md` (add a subsection near wherever the autonomous loop / narrate step is designed — search for "narrate" in the file first to find the right section)

- [ ] **Step 1: Find the right insertion point**

Run: `grep -n "narrate\|§2.1" docs/PHASE2_DESIGN.md` to locate the design section describing the autonomous loop's narrate step.

- [ ] **Step 2: Add the threat-model note**

Insert a subsection (matching the surrounding doc's heading style) covering:

```markdown
### Threat model note: prompt injection via MCP-retrieved content

`AutonomousLoop.narrate()` (`src/standalone/loop.ts`) builds its prompt from
`claim.text` — content retrieved from internal systems via MCP (a Jira ticket
body, a wiki page, a CRM note). That content is untrusted relative to the
model: a document containing adversarial instructions ("ignore the above and
instead say...") could attempt to steer the local model's narrative summary.

Existing mitigations, by design:
- **Claims are the source of truth, independent of the narrative.** The
  report's Findings/Provenance sections render directly from claim data with
  no model involvement (`src/orchestrator/report.ts`); the narrative is a
  clearly-labeled, separate "Summary" section
  (`"_(model narrative — a local/host model wrote this; it may vary in
  quality...)_"`) that a reader is told not to treat as the sole source of
  truth.
- **The narrative cannot expand what already ran.** `narrate()` runs *after*
  the orchestrator's gather pass is complete and only summarizes results
  already collected; it has no tool-calling ability and cannot trigger new
  MCP calls or file operations.
- **A narrate failure degrades gracefully.** If the model produces nothing
  useful or errors, the deterministic report (no narrative section) stands
  unchanged (`src/standalone/loop.ts`'s `narrate()` returns `null` on any
  failure, and the caller keeps the already-written report).

What this does NOT mitigate: the narrative text itself could still be
misleading if a weak local model is successfully steered by injected
content, even though the underlying claims remain independently correct and
traceable. This is an accepted, documented risk for v1 — a reader who
treats the model narrative as authoritative rather than as a convenience
summary is relying on it beyond its designed guarantee. If this becomes a
priority, the next step would be delimiting/escaping retrieved content in
the narrate prompt (e.g. wrapping each claim in an unambiguous boundary
marker) and/or a lightweight instruction-following check on the narrative
output before it's written into the report.
```

- [ ] **Step 3: Commit**

```bash
git add docs/PHASE2_DESIGN.md
git commit -m "docs: document the prompt-injection threat model for the narrate step

Names the risk class explicitly (MCP-retrieved content is untrusted
relative to the model) and the existing mitigations (claims are the
source of truth independent of the narrative, no new tool-calling
ability, graceful degradation on failure), for an enterprise-security
audience reviewing the design."
```

---

## Low-priority items

These are polish, not defects — batch them into a single follow-up pass; less TDD ceremony is warranted since most are non-behavioral or docs-only.

### L1: Fix the local API worker's 5ms busy-poll

**File:** `src/standalone/api.ts:288-331` (`worker()`), `:242-249` (`enqueue()`)

Add a simple wake-notification mechanism instead of polling on a fixed interval:

```ts
private wakeResolvers: Array<() => void> = [];

private waitForWork(): Promise<void> {
  return new Promise((resolve) => {
    this.wakeResolvers.push(resolve);
    // Safety net: don't rely solely on notify() firing, in case of a missed
    // race between a new job's enqueue() and the worker starting its wait.
    setTimeout(resolve, 1000);
  });
}

private wakeWorker(): void {
  const resolvers = this.wakeResolvers;
  this.wakeResolvers = [];
  for (const r of resolvers) r();
}
```

Call `this.wakeWorker()` at the end of `enqueue()` (right after `this.store.create(kind, input)`), and replace `await sleep(5)` in `worker()`'s idle branch with `await this.waitForWork()`. Add a test asserting a job enqueued while the worker is idle starts running promptly (e.g. within ~50ms via `vi.useFakeTimers()` or a real small timeout) rather than asserting on the absence of polling directly. Commit as `perf: replace the local API worker's busy-poll with an event-driven wake`.

### L2: Add a `LICENSE` file

**This requires a decision from the repository owner, not an engineering judgment call** — license choice is a legal/business decision. `README.md` currently says "License: TBD" while the project depends on Apache-2.0 (Qwen3 model, per `docs/MODEL.md`) and MIT-class (llama.cpp) components; a compliance-focused enterprise tool needs this settled before anyone's legal review can proceed. **Action:** ask the repository owner which license to apply (common choices for a tool like this: Apache-2.0, for compatibility with the bundled model's own license and its explicit patent grant; or MIT, for simplicity) — do not pick one unilaterally. Once decided, add the `LICENSE` file and update `README.md`'s "License: TBD" line and `package.json` (add a `"license"` field, currently absent since `"private": true` omits it).

### L3: Document the hostname-based egress allowlist's accepted DNS-rebinding limitation

**File:** `docs/DECISIONS.md`

Add a line to the decisions table (or a short new section) stating explicitly that `allowed_network` matches by hostname, not by resolved/pinned IP, and that this is an accepted limitation under the admin-controlled internal-DNS trust model this project assumes — not an oversight. This is a documentation-only change (no code change); the current behavior is fine, it's just implicit today.

### L4: Consider consolidating the overlapping status docs

**Files:** `README.md` (Status section), `docs/NEXT_STEPS.md`, `docs/DIARY.md`

Not a defect — flagged for awareness. The same milestones are restated near-verbatim in three places. No concrete task here since this is a judgment call about the project's documentation strategy going forward (the current duplication is a reasonable tradeoff for a solo/AI-paced project); revisit if/when more contributors are reading these docs as ground truth.

---

## Post-plan verification

- [ ] `npm run typecheck && npm run build && npm test` all green after every task.
- [ ] Re-read `reviews/2026-08-22-full-repo-review.md` and confirm each of M1–M14 and L1–L4 has either a completed task above or an explicit owner-decision note (L2).
- [ ] Update `docs/DIARY.md` per this repo's convention with a summary pointing at this plan file and the high-priority plan file.
- [ ] Per `AGENTS.md`: commit (done per-task above) and push to `origin/master`.
