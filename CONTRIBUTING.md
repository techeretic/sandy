# Contributing to Sandy

Thanks for helping build Sandy — the [sandboxable AI assistant](README.md) that
talks only to declared MCP servers and never leaves its boundary. This project
is fail-closed by design; contributions should keep it that way.

## Where the docs live

Per the doc-role convention, keep the docs distinct and point at the source
instead of restating it:

- **`README.md`** — headline status + links.
- **`guide/`** — *how to use it*. Start with [`guide/development.md`](guide/development.md),
  which covers the toolchain, commands, repository layout, conventions, and CI.
- **`docs/`** — *why* and *how it got here* (`PRD_Final.md`, `PHASE2_DESIGN.md`,
  `MODEL.md`, `DECISIONS.md`, `NEXT_STEPS.md`, `DIARY.md`).

## Setting up locally

Requires **Node ≥ 22**. TypeScript 5.9 is pinned (strict, ESM) — do not bump
`typescript` past 5.9 (the 7.x native compiler has a `@types/node` auto-include
bug).

```bash
npm ci          # install the locked dependencies
npm run build   # compile src/ → dist/
```

The CLI runs from `bin/sandy.js` (Sandy refuses to start outside a sandbox —
that is a feature, not a bug):

```bash
node bin/sandy.js check --config config/sandy.json
```

## Build, test, lint commands

There is **no separate lint step** in this repo; `typecheck` + `test` are the
gates (plus conformance for the security guarantees).

| Command | What it does |
|---------|--------------|
| `npm run typecheck` | Type-check without emitting. |
| `npm run build` | Compile `src/` → `dist/` (`tsconfig.build.json`). |
| `npm test` | Run the full Vitest suite. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:conformance` | In-process conformance (no Docker needed). |
| `npm run conformance` | In-process + Docker egress + Docker/Firejail sandbox matrix. |

**After any change:** `npm run typecheck && npm test`. Add `npm run build` when
`dist/` matters (the CLI and Docker/Firejail conformance legs run against the
built output).

CI (`.github/workflows/ci.yml`) runs a `core` job — typecheck, build, test,
in-process conformance — then a `boundary × mode` matrix (docker/firejail ×
plugin/standalone) that uploads per-leg behavior signatures, then an `identity`
job that requires the Docker and Firejail signatures to be byte-identical per
mode (SB-10 / SD-05/06). If your change touches egress, sandbox detection, the
File Manager, or the standalone loop, run the relevant conformance legs locally
before opening a PR.

## The invariants (keep them)

These are the project's load-bearing rules, restated from
[`guide/development.md`](guide/development.md#conventions-the-invariants--keep-them):

- **Fail closed** everywhere; never smooth over a gap; **policy > preferences** (tighten, never loosen).
- **Secrets only as `${ENV_REF}`**; resolve at point of use, never store or log; args logged by hash only.
- **No network outside the declared MCP allowlist** — everything goes through `NetworkGuard`.
- **One definition of a legal request** — the shared request schema + legal tool catalog is used by the CLI, the plugin, the API, and the loop.
- Deterministic, zero-dependency report renderers (Markdown is the source of truth).
- Injectable seams for tests — but **no production-reachable override**.

When in doubt, the 2026-08-22 full-repo review and its fix plans in
`reviews/` are the best worked example of how a finding gets analyzed,
scoped, and fixed fail-closed.

## Branching and commit conventions

- One branch per unit of work, off `master`. Existing convention:
  - `feat/issue-<n>-<slug>` for tracked issues (e.g. `feat/issue-16-write-back`)
  - `fix/issue-<n>-<slug>` for issue-driven fixes
  - `fix/ghsa-<id>-<slug>` for security advisories
  - `chore/<slug>` for maintenance
- Conventional-commit prefixes with an imperative subject: `feat:`, `fix:`,
  `docs:`, `test:`, `perf:`, `security:`, `release:`.

## Submitting a PR

1. Fork (if applicable) and create a branch named per the convention above.
2. Make your change. Add or update tests in `tests/` — the suite currently
   covers every module plus end-to-end composition, and new behavior should
   join it. Use `tests/helpers/mcp.ts` for in-process MCP servers.
3. Run the gates: `npm run typecheck && npm test` (and the relevant
   `npm run conformance:*` legs if you touched a security-critical path).
4. Open a pull request against `master`. Describe the behavior change, how you
   verified it, and link any issue or advisory it closes.
5. Keep PRs scoped — one branch + PR per finding/feature is the working norm
   here.

Security-relevant changes are reviewed against the fail-closed invariants above;
changes that would loosen a gate (an allowlist, a confirmation, a boundary
check) need an explicit justification in the PR description.

## Security issues

Do **not** open a public issue for a vulnerability. See
[SECURITY.md](SECURITY.md) — reports go through GitHub private security
advisories.

## Code of conduct

This project follows the [Contributor Covenant v2.1](CODE_OF_CONDUCT.md).
