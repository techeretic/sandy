---
name: Feature request
about: A new capability, config option, or behavior change
title: ''
labels: enhancement
assignees: ''
---

**What would you like?**
A clear, concise description of the feature or change.

**Why is it needed?**
The problem it solves. Sandy is deliberately minimal — MCP-only, VPN-safe,
fail-closed, least privilege — so a strong "why" that fits those constraints
matters more than a strong implementation sketch.

**Deployment mode(s) affected**
<!-- plugin (Claude Code / Codex via the sandy.* MCP tools) | standalone (sandy ask / sandy serve) | both -->

**Proposed shape (optional)**
Config keys, CLI flags, or tool names you have in mind. Note if the feature
would touch a security boundary — anything that widens an allowlist, adds an
endpoint, or relaxes a gate needs an explicit fail-closed design and will be
reviewed against the invariants in `guide/development.md`.

**Alternatives considered**
Other ways to get the same outcome with existing config/tools.

**Additional context**
Relevant PRD/decision references (`docs/PRD_Final.md`, `docs/DECISIONS.md`,
`docs/NEXT_STEPS.md`) if the idea intersects settled scope. Note: some items
are deliberately deferred and tracked in `docs/NEXT_STEPS.md` — linking the
existing item (or confirming none exists) saves a duplicate.
