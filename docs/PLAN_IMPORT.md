# Implementation Plan: `sandy import`

Design: `docs/IMPORT_DESIGN.md`. Scope for this PR = the **deterministic** pipeline (design §Pipeline steps 1, 3, 4, 5). The `--auto` LLM-transcription path is explicitly deferred (see note at the end) — it needs an LLM client in the core, which v1 doesn't have.

## Files

| File | Change |
|---|---|
| `src/audit/logger.ts` | Add audit event types `import_fetch`, `import_staged` |
| `src/import.ts` | **New.** The import pipeline: fetch → sniff → validate → stage → (apply) |
| `src/cli.ts` | New `import` verb + flags; error translation; help text |
| `tests/import.test.ts` | **New.** Unit tests (in-process HTTP server for URL tests) |
| `guide/cli.md` | Document the new verb |
| `docs/IMPORT_DESIGN.md` | Status: v1 scope note |

## `src/import.ts` — API

```ts
const IMPORT_DEFAULTS = { timeoutMs: 30_000, maxBytes: 1_048_576, maxRedirects: 3 };

export class ImportError extends Error { code: 2 | 3 }

export interface ImportSource {
  url?: string; file?: string; stdin?: boolean;
}

export interface StagedImport {
  path: string; hash: string; fetchedAt: string;
  source: string; manifest: McpServersManifest;
  networkLines: string[];           // computed host:port for remote servers
  envNames: string[];               // env-var names referenced (never values)
  questions: Array<{ server: string; exposed: string[]; allowed: string[] }>;
}

export interface ImportOptions {
  configPath?: string;
  stageDir?: string;                // default: ./.sandy-import
  audit?: AuditLogger;
  yes?: boolean;
  apply?: boolean;
  tools?: Record<string, string[]>; // server → explicit allowed_tools
  fetcher?: (url: string, opts: { timeoutMs: number; maxBytes: number; maxRedirects: number }) => Promise<ImportFetchResult>; // test seam
  confirm?: () => Promise<boolean>; // test seam
  now?: () => Date;                 // test seam
}

export async function runImport(source: ImportSource, opts: ImportOptions): Promise<ImportResult>
```

### Pipeline details

1. **Fetch** — `fetchManifest(url)`: `https/http` only (anything else → usage error). Follows ≤3 redirects, validates each hop's URL (URL-parsing only, no dialing — the guard's job is scheme+parse here; the *dial itself* is the human-confirmed exception). 30s `AbortSignal.timeout`, streams the body with a 1MB running cap. `fetcher` seam for tests. Confirmation: prints the exact `GET <url>`, asks `Proceed? [y/N]` on stdin (default **no**; `--yes` skips; `confirm` seam).
2. **Ingest** — file / stdin (`-`) / fetched bytes → UTF-8 text.
3. **Sniff + validate** — must parse as a JSON object matching the **existing** `mcpServersManifestSchema` (fail-closed, code 3 on violation). Prose (non-JSON, or JSON that isn't a manifest) → error: "not a machine-readable manifest (v1 is deterministic-only; `--auto` not implemented yet)".
4. **Tools** — if `--tools server=a,b` given for a staged server: every named tool must be in that server's `capabilities` (fail-closed) and the result non-empty; otherwise `allowed_tools` stays exactly as the manifest declared it (never auto-expanded).
5. **Stage** — write `<stageDir>/<sha256>.json` (default stageDir `./.sandy-import`; hash of the ingested bytes, so re-importing identical content is an idempotent no-op) with shape:
   ```json
   { "source": {"url": "…", "sha256": "…", "fetchedAt": "…"}, "manifest": { "servers": [ … ] } }
   ```
   Then print the **review package**: staged path + hash, per-server summary, the exact `sandbox.allowed_network` entries to add (computed with the same port-reconstruction rule as `endpointMatches`), the env-var **names** to export, and the allowlist question per server ("exposes N, allows M — confirm or `--tools <server>=a,b`").
   - `audit.append("import_fetch", { url, sha256, bytes })` after a successful fetch; `audit.append("import_staged", { path, sha256, servers, applied })` after staging/apply.
6. **Apply** (`--apply` only) — requires a loadable config (`loadSandyConfig`, fail-closed code 3 if absent/broken — apply can't compute what it merges into). Name collision with an existing server → hard failure. Writes:
   - manifest file: parsed original JSON → append servers → `JSON.stringify(…, null, 2) + "\n"` (key order of existing entries preserved by the JSON parser),
   - `sandy.json`: same approach, appending missing `allowed_network` entries only,
   - then re-runs `loadSandyConfig` on the result as the final gate (catches VPN-02 etc. before it ships).

### CLI wiring (`src/cli.ts`)

- verb `import`, one positional: `https?://…` | existing file | `-` (stdin).
- flags: `--yes` (skip the fetch prompt), `--apply`, `--tools <server=a,b[;server2=c,d]>` (repeatable). Reuse `-c` (config) and `-o` (audit).
- `--json` prints `{staged, hash, applied, review}`; default prints the review text.
- Exit codes: usage errors → 2, config/manifest errors → 3 (mapped from `ImportError.code`).

## Tests (`tests/import.test.ts`)

- URL: serves a valid manifest over an in-process HTTP server → staged file written, hash correct, audit `import_fetch` + `import_staged` recorded; `confirm` seam required (no auto-yes).
- URL: non-https scheme rejected; over-size body rejected; timeout respected (delayed server); redirects followed within cap.
- stdin: piped manifest bytes → staged.
- Prose content → error mentioning v1 deterministic-only.
- `--tools`: filters `allowed_tools`; unknown tool → fail-closed.
- `--apply`: appends server to a fixture manifest, adds `allowed_network` entries, preserves other entries + key order; collision → failure; final re-validation catches a VPN-02 violation (apply a manifest whose endpoint is never added — unreachable in practice, so test via a broken config instead: apply with missing env var → code 3).
- `allowed_network` computation: `https://host:443/mcp` → `host:443`; non-default port kept.
- CLI: `sandy import --help` lists the verb; bad source (missing file) → usage error exit 2.

## Verification

`npm run typecheck && npm test && npm run build`

## Deferred (documented, not in this PR)

- `--auto` / `--auto-model`: LLM transcription of prose pages. The core has no LLM client (plugin mode reasons in the host; standalone uses the model engine inside the sandbox loop), so a clean home for this is a follow-up (likely `sandy.ask`-adjacent or a dedicated engine call). `docs/IMPORT_DESIGN.md` will say so.
- `--apply` interactive prompts (the allowlist question is print-only in v1; answering it means re-running with `--tools`).
