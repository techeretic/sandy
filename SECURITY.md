# Security Policy

Sandy is a security-critical project: its entire purpose is to **never** leave
the sandbox, **never** egress outside declared MCP endpoints, and **never**
loosen a policy gate. If you believe you have found a defect that breaks any of
those guarantees — or any other vulnerability — please read this before you
report it.

## Reporting a vulnerability

**Do not open a public issue.** Public issue reports about vulnerabilities are
closed without disclosure.

Use one of the following:

1. **GitHub private security advisory (preferred).** Open
   `techeretic/sandy` → **Security** → **Reporting a vulnerability** →
   **New private vulnerability report**. This is the channel the maintainer
   already uses for findings (the 2026-08-22 review's 7 fixes were tracked as
   private advisories, GHSA-…, and released as a patch version with the
   advisories published alongside).
2. **Email:** `[SECURITY CONTACT — fill in, e.g. the maintainer's email]`
   <!-- TODO(maintainer): replace the placeholder above with the actual
        security contact email, or delete this option and keep only the
        private-advisory channel. -->

A useful report includes:

- A summary of the affected component (sandbox enforcer, NetworkGuard,
  PathConfinement, MCP client, File Manager, standalone loop/API, plugin).
- How the guarantee is broken: e.g. egress outside the allowlist, a path
  escape outside the working root, a gate that can be bypassed, an
  unauthenticated reach into the loopback API, or a fail-open where the code
  should fail closed.
- A minimal reproduction: the `sandy.json` / `mcp-servers.json` config, the
  request, and the commands run. The `conformance/` harnesses are a good model
  for a self-contained proof.
- Which mode(s) are affected (plugin / standalone) and which boundary(s) you
  observed it under (none, Docker, Firejail).

**Do not include live credentials, tokens, or internal endpoint details.**
Secrets in Sandy are `${ENV_REF}` placeholders; a report that needs a real
secret to reproduce should describe the shape of the secret, not its value.

## Response

- Acknowledgment of a valid report is expected **within 5 business days**
  (placeholder — confirm the real target with the maintainer).
  <!-- TODO(maintainer): confirm or replace the 5-business-day target. -->
- The goal is a fix in the next patch release, followed by publication of the
  advisory with `patched_versions` pointing at the release that fixes it,
  matching the process used for the v0.1.1 advisories.
- Credit in the advisory is at the reporter's choice; anonymous disclosure is
  supported.

## Supported versions

Sandy is pre-1.0. Only the current release line is supported for security
fixes:

| Version | Supported |
|---------|-----------|
| 0.1.3 (current) | Yes |
| < 0.1.3 | No — upgrade to the latest release |

Releases are tagged `vX.Y.Z` on this repository. The conformance suite
(`npm run conformance`) is the reference proof of the egress and
runtime-agnosticity guarantees; a fix that does not keep the conformance
signatures byte-identical across Docker and Firejail is not complete.

## Scope notes

Two accepted limitations are documented, not open vulnerabilities — see
`docs/DECISIONS.md` before reporting them:

- The narrate threat model (model output in reports is clearly labeled as
  model narration, not source data).
- The DNS-rebinding limitation of the loopback REST API (mitigations and the
  accepted residual risk are settled in the decisions log).
