## What this changes

<!-- One or two sentences: the behavior change and why. -->

**Closes / related:** <!-- issue number(s), advisory, or docs/NEXT_STEPS.md item, if any -->

**Mode(s) touched:** <!-- plugin (sandy run) | standalone (sandy ask / sandy serve) | both / neither (build tooling, docs, tests) -->

## Verification

Run and paste results (CI runs the same gates — see `.github/workflows/ci.yml`).
There is no separate lint step in this repo; typecheck + test are the core gates.

- [ ] `npm run typecheck`
- [ ] `npm run build` (when `dist/` matters — CLI and conformance legs run the built output)
- [ ] `npm test` (full Vitest suite)
- [ ] `npm run test:conformance` (in-process egress + sandbox conformance, no Docker needed)
- [ ] `npm run conformance:docker` — **required** if the change touches egress, `NetworkGuard`, sandbox detection, or the MCP client
- [ ] `npm run conformance:sandbox` — **required** if the change could alter behavior under Docker vs Firejail (the identity job requires byte-identical signatures per mode, SB-10 / SD-05/06)
- [ ] New/updated tests in `tests/` for the changed behavior (use `tests/helpers/mcp.ts` for in-process MCP servers)

## Security-relevant?

<!-- If yes: which guarantee is touched (egress allowlist, path confinement,
     confirmation gate, loopback API, model memory bound), and how the change
     keeps it fail-closed. Do NOT paste secrets or real ${ENV_REF} values.
     If this PR fixes a vulnerability, reference the private advisory instead
     of describing the flaw in detail. -->

- [ ] N/A
- [ ] Yes — details above

## Docs

<!-- Per the doc-role convention: README = status + links, guide/ = how to use,
     docs/ = why/how it got here. Don't restate a milestone in more than one. -->

- [ ] N/A
- [ ] `guide/` updated (user-visible behavior changed)
- [ ] `docs/DIARY.md` entry added (and `README.md` Status touched, if status changed)
