---
name: Bug report
about: Something behaves incorrectly — a gate that fails open, a wrong report, a crash, a broken CLI/plugin/API path
title: ''
labels: bug
assignees: ''
---

**Describe the bug**
A clear, concise description of what is wrong and what you expected instead.

**Sandy version**
<!-- `node bin/sandy.js --version`, or the release tag, e.g. v0.1.3 -->

**Mode and boundary**

- Mode: <!-- plugin (`sandy run`) | standalone (`sandy ask` / `sandy serve`) -->
- Sandbox: <!-- none | Docker | Firejail | WSL | gVisor | other: ___ -->
- Node: <!-- `node --version`, ≥ 22 -->

**To reproduce**
Commands and, if needed, a minimal `sandy.json` / `mcp-servers.json`.
Keep MCP server names realistic but do not include live credentials —
secrets are `${ENV_REF}` placeholders and must stay that way in reports.

```bash
# e.g.
node bin/sandy.js check --config config/sandy.json
node bin/sandy.js run <request.json> --config config/sandy.json
```

**Actual behavior**
What happened. For security-relevant symptoms (egress outside the declared
allowlist, a path outside the working root, a skipped confirmation gate,
fail-open where fail-closed is expected) include the exact config keys and
commands involved — those defects are tracked as private advisories, not
public issues, so describe the mechanism without secrets.

**Expected behavior**
What you expected, citing the guarantee if possible (e.g. SB-03 "refuse to
start without a boundary", VPN-02 egress fail-closed, SB-10 identical
behavior across boundaries).

**Logs / output**
<!-- CLI output with --json if relevant; audit log excerpts are fine (args are
     logged by hash only). Trim anything sensitive. -->

**Additional context**
Conformance output if the bug is boundary-related:
`npm run test:conformance` (in-process), `npm run conformance:docker`
(Docker egress), `npm run conformance:sandbox` (Docker + Firejail matrix).
