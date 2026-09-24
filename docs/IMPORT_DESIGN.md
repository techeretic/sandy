# Design: `sandy import` — URL-driven MCP server configuration

**Status:** v1 implemented (deterministic pipeline: fetch → validate → stage → `--apply`)
**Date:** 2026-09-20

> **v1 scope note:** the `--auto` LLM-transcription path (and `--auto-model`) is
> **deferred** — the core has no LLM client in v1 (plugin mode reasons in the
> host; the standalone model engine lives inside the sandbox loop). Prose URLs
> are rejected fail-closed with a pointer to this note. Everything else in this
> design — the one-shot confirmed/audited fetch, the shared validation gate,
> content-hash-pinned staging, the review package, `--apply` with the final
> re-validation gate, collision refusal, and the audit events — is implemented
> in `src/import.ts` (CLI: `sandy import <url|file|->`). See
> `docs/PLAN_IMPORT.md` for the v1 implementation plan.

## Problem

Today, configuring an MCP server in Sandy is a manual, multi-file, security-critical act: write an entry in `mcp-servers.json` (transport, command/URL, exact-semver `version`, `capabilities`, `allowed_tools`), declare the endpoint in `sandbox.allowed_network`, export env-var secrets, and let the fail-closed loader validate it. Operators know *which* server they want, but the details — endpoints, tool names, auth shape — live in remote documentation.

`import` closes that gap: **point Sandy at a URL (or file) that describes an MCP server, and it produces a validated, reviewable, content-pinned candidate configuration.**

## Commands

```
sandy import <url>            # fetch (one-shot confirmed egress) → sniff → stage
sandy import <file|->         # ingest local file / stdin → sniff → stage
sandy import <…> --apply      # explicit opt-in: write staged entry to live config
sandy import <…> --auto       # opt-in LLM interpretation for prose URLs
sandy import <…> --tools a,b  # answer the allowlist question at import time
```

- `sandy import <url>` works identically in **plugin** and **standalone** mode — Sandy dials the URL itself, so no host LLM is required for the flow to exist.
- `sandy import <file|->` is the air-gap / host-fetched path: zero network involved.

## Pipeline

One pipeline, two intake paths, one trust gate. **Nothing is legal because a URL or a model said so — the schema is the law in both paths.**

1. **Fetch**
   - For URLs: Sandy prints the exact `GET <url>` it will perform, requires **human confirmation**, then dials with a timeout and size cap. This is a **one-shot egress exception** — the only permitted deviation from the zero-egress invariant — and is recorded in the audit log as a distinct event type.
   - For files/stdin: no network at all.

2. **Normalize**
   - Sniff the content.
   - **Deterministic path:** the content is a machine-readable manifest in (or trivially convertible to) the `mcp-servers.json` schema. No LLM involved; it flows straight to validation.
   - **Prose path:** the content is a human-facing page (README, product docs). This path is **opt-in via `--auto`** — without the flag, a prose URL is an error, keeping the default import fully deterministic.
     - Plugin mode: the host LLM transcribes the page into a *candidate* manifest.
     - Standalone mode: the bundled local model transcribes; this tier is **experimental** (documented as such), with a `--auto-model` escape hatch for a stronger model.
     - The LLM is a **transcriber with no special powers**: its output is a candidate that the deterministic validator decides is legal or not. A hallucinated field, a missing exact-semver pin, or a literal secret → validation fails, fail-closed, exit 3.

3. **Validate**
   - The candidate runs through the **existing** `mcpServersManifestSchema` (fail-closed, exit 3 on any violation), plus the existing cross-checks:
     - `allowed_tools` ⊆ `capabilities`; `allowed_tools` non-empty (MCP-07);
     - exact-semver `version` required (MCP-08 / VCS-reviewed updates);
     - secrets are `"${ENV_REF}"` only — a URL may describe *which* secret is needed, never smuggle its *value* (MCP-08);
     - `sse`/`http` endpoints are checked against `sandbox.allowed_network` exactly as the loader does today (VPN-02) — with the difference that at staging time this is *reported and pre-satisfied in the review package*, not fatal.

4. **Stage** (default)
   - **Nothing touches live config.** The validated candidate is written to `.sandy-import/<sha256>.json` — the **content hash of the fetched bytes is the filename and is pinned into the entry**. The default staging dir `.sandy-import` is resolved **relative to the config directory** (the same anchor as `report_output_dir`), not the process cwd, so a `sandy import` run from any directory stages next to `sandy.json` and never leaves a stray dir in the current one. An explicit `--stage-dir` override is honored verbatim (cwd-relative if given as a relative path). Consequences:
     - The URL is a *source at time T*, not a live channel. A later re-import of a changed page produces a **different hash → a fresh staged diff** — server updates are reviewed too, consistent with the VCS-reviewed-registry model.
   - The command then prints the **review package**:
     - the proposed server entry (with its content-hash pin visible);
     - the exact `sandbox.allowed_network` line(s) to add (computed from the endpoint, so VPN-02 is satisfied once the operator commits them);
     - the env vars to export (names only, never values);
     - the **allowlist question**: the server exposes *N* capabilities; *M* are allowed in the candidate. The operator confirms or picks (`--tools a,b`). The default is *exactly what the manifest declared* — import never auto-expands the read allowlist, because choosing which tools are legal is a human decision, not a transcription one.

5. **Apply** (explicit)
   - Only `--apply` — or the operator manually applying the staged diff — promotes the entry into `mcp-servers.json` (and, when `--apply` is used, appends the `allowed_network` lines to `sandy.json`).
   - **Name collision with an existing server → hard failure**, never an overwrite. Re-importing the same content is a no-op (hash match).

## Edge cases

- **Multiple servers in one manifest** — staged as a batch; one review package, one diff.
- **Air-gap** — the file/stdin path requires no network; an operator can fetch on a connected machine and import from a file on the sandboxed one.
- **Endpoint unreachable from the sandbox** — reported in the capability manifest as reduced mode (the existing convention for `allowed_network` endpoints the boundary can't reach), not a crash.
- **Fetch failure** (DNS, timeout, oversize, TLS) — clean error, nothing staged, audit event recorded.

## Invariants preserved

| Invariant | How `import` respects it |
|---|---|
| **Zero egress by construction** | Extended to "zero egress except a human-confirmed, audited, one-shot import dial." The imported server's own endpoint remains a normal reviewed config change — import never silently widens the sandbox. |
| **Fail-closed config** | The candidate is the *existing* schema's business. Invalid candidate → `ConfigError`, exit 3. No new validation surface. |
| **VCS-reviewed updates** | Default flow leaves a staged diff to review and commit; `--apply` is a conscious bypass for operators who opt out. Content-hash pinning makes remote updates a fresh, reviewable event. |
| **Secrets are env-refs only** | Validation rejects literals. The URL can specify `token: "${JIRA_TOKEN}"`-shaped requirements; the value always comes from the operator's environment. |
| **Nothing is legal because it's "saved" or "planned"** | Same rule, new source: nothing is legal because a *URL* or a *model* said it was. The allowlist is the operator's, confirmed at staging. |
| **Audit log is the forensic record** | New event types for the import dial, the content hash, the LLM-assisted interpretation (which model, when), and the apply decision. |

## Open questions (deferred)

- Manifest conversion: how far should the deterministic path reach beyond the native schema (e.g. a third-party "server card" registry format)? Start native-only; extend the normalizer later.
- `--auto-model` backends: which remote endpoints are sane to allow for the experimental standalone tier, given egress policy.
- Whether staged imports should also pre-validate that a `stdio` `command` resolves *inside* the sandbox before apply (today this surfaces as reduced mode at startup).
