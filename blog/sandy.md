# The AI assistant that can't leave the sandbox

*Why "Sandy" exists, what it will do for you, and why your security team will actually sign off on it.*

---

You've been there. You're a knowledge worker inside a big enterprise — a sales ops analyst, an SRE, an eng manager, a PM. You want an AI assistant to pull together the stuff you already have to read by hand: the CRM, Jira, the wiki, the dashboards, the incident channel. You want it to draft the Monday report, flag the at-risk deals, summarize the sprint, turn the chaos into something a human can act on.

And you can't.

Not because the models aren't good enough. They are. But because your data lives behind the VPN, and every hosted AI assistant you've tried wants to ship that data out the door. Data-egress rules, sandbox policies, network segmentation — the same controls that protect the company — block the tool that would save you hours. You end up copy-pasting into a browser tab you're not supposed to use, and the report is a mess of screenshots and "trust me, I checked Jira."

That gap is the entire reason **Sandy** exists.

## What Sandy is, in one sentence

**Sandy is an AI assistant that lives inside your sandbox, talks to your internal systems only through MCP servers you explicitly declare, and never — not ever — touches the network or your files except through a boundary it can prove it cannot leave.**

It gathers information from your internal workplace services (CRM, Jira, databases, wikis, observability), and turns it into a **report with full provenance** — every single claim footnoted to the exact source call that produced it. Then it manages files and folders inside the sandbox, with confirmation gates, undo, and dry-run.

The name is the whole pitch: **S — ANDBOXable**.

## The problem with "just use the big model"

The instinct is to point a frontier model at your internal systems and let it rip. It works — until one of three things happens:

1. **Egress.** The assistant phones home with your data. The network policy is now a suggestion. Your security team finds out.
2. **Fabrication.** The model summarizes "from the CRM" but you can't tell which ticket, which field, which moment in time it's quoting. The number in the report is right until it isn't, and nobody can tell.
3. **Scope.** It does something you didn't ask it to do, somewhere you didn't point it.

Each of these is a reason the assistant gets killed at the pilot stage. Sandy is built so that **none of the three can happen by construction, not by policy.**

## How Sandy makes it impossible

The design is a single, load-bearing split: **an untrusted reasoner, and a fixed, sandboxed, audited executor.**

A reasoner — your host LLM in Claude Code or Codex, or a small local model — *proposes* a plan of MCP tool calls. Sandy, the executor, *validates* that plan against a policy, runs *only* what is legal, inside a sandbox it proves it can't leave, and turns the results into a report. The reasoner is swappable and **never trusted**. The executor is fixed, deterministic, and audited.

That split is what makes the rest fall out:

- **MCP-only communication.** There is no general HTTP client in Sandy. Every network dial goes through a single choke point — the *NetworkGuard* — which allows only `http(s)` to a `host:port` you declared in config. No raw HTTP, no gRPC, no SSH, no "oh, the model said to call that endpoint." If it's not on the allowlist, it doesn't happen.
- **Zero egress outside declared endpoints.** This is the launch success criterion, and it isn't a promise — it's a **proof**. It's demonstrated in-process and at the network level in Docker, and the enforcer is proven **runtime-agnostic**: the same config + request under Docker and under Firejail produce byte-identical behavior. Same input, same behavior, different enforcing boundary.
- **VPN-safe by construction.** Sandy never tunnels around, proxies past, or routes over your VPN rules. It operates *within* them. The endpoints it reaches are the ones your network already permits.
- **Least privilege.** Per-server tool allowlists are applied *before* a tool is even wired in, and every request is re-validated against the legal catalog. A model can only plan what your policy already allows — and it can't make an illegal plan legal by retrying.
- **Fail closed, always.** No boundary detected? Sandy refuses to start. Config invalid? It exits with a code and a message, it doesn't guess. A write that isn't approved? Refused, and never retried. The default posture is read-only — **writes are off until an admin allowlists them and a human approves each one.**
- **Auditable end to end.** An append-only, structured log records every MCP call (by args-hash), every file mutation and undo, every write attempt and decision, every model invocation, every blocked egress. It's the forensic record that answers "what did it do, with what, when?" — the thing your compliance owner will ask for.

## The part that sells itself: the report

Sandy's output is a report in **Markdown, HTML, DOCX, XLSX, or PDF** — your choice, per run or as a default. All five render the same content, because the report is a **deterministic function of the claims and gaps** — no model is involved in the scaffolding, so it's stable, testable, and **cannot fabricate.**

Every claim carries a footnote to its source: the server, the tool, a hash of the args, and the timestamp. And when a source *doesn't* contribute — a 500, an empty result, an unreachable server — Sandy records an explicit **gap** in its own section. It does not paper over the hole. It does not invent a plausible number to fill it. A report with gaps in it is more honest than a clean report with a lie in it, and your readers can tell the difference at a glance.

That last property is the one that matters most in a workplace. **You can stand behind every number in a Sandy report, because the report tells you exactly where it came from.**

## Two ways to run it

**Plugin mode** — the fast start. Install the Sandy plugin into Claude Code or GitHub Codex. Your host LLM does the reasoning and calls a small set of `sandy.*` tools over MCP; Sandy executes them deterministically inside the sandbox and hands back the claims, gaps, and report path. The host model never touches the network or filesystem directly — it can only go through Sandy. This is the "the host LLM plans, Sandy does the sandboxed work" split, and it gets you running in minutes if you're already in a coding/assistant host.

**Standalone mode** — the full answer for the locked-down end. Run Sandy with a **small local model bundled in** — Qwen3-4B-Instruct by default — as a subprocess on loopback *inside the same sandbox*. The model plans, Sandy validates and runs it, the model narrates (clearly labeled), and a single provenance-tracked report is written. The model's only network path is loopback to its own process, so the whole system has **zero external egress by construction.** This is for the environment no frontier model can reach at all: fully local, VPN-restricted, or air-gapped. `sandy serve` runs it as a loopback-only REST + SSE service for a UI or other local tools.

Both modes share the same core — the same enforcer, the same MCP manager, the same file manager, the same orchestrator, the same audit log. The only difference is who sits in the "reasoner" seat.

## "But can we prove it?"

Yes — and that's the point. Sandy ships a **conformance suite** that doesn't just assert the guarantees, it demonstrates them:

- an in-process egress + sandbox proof that runs with no Docker;
- a **Docker network-level egress proof** — the declared endpoint is hit, an independent external-egress probe from inside the sandbox **fails**, and an undeclared endpoint **fails closed at startup**;
- a **Docker + Firejail matrix** that runs the same config + request under both boundaries and requires **byte-identical** behavior;
- all of it, for **both** modes, in a CI matrix.

You don't take Sandy's word for "no egress." You run `npm run conformance` and watch it prove it.

And it's been **reviewed and hardened**: a full-repo security review closed 7 findings (shipped as private advisories), followed by a dozen more fix PRs. 323 tests, typecheck and build green. Apache-2.0 licensed, with a minimal, auditable dependency set — the binary report containers are hand-rolled on purpose, to keep the install clean.

## Try it

You don't need to trust us. You need a sandbox and a few minutes.

```bash
git clone <your-sandy-repo-url> sandy && cd sandy
npm ci && npm run build
node bin/sandy.js check -c config/sandy.json     # validate + capability report
node bin/sandy.js run <request.json> -c config/sandy.json   # gather → provenance-tracked report
```

Point it at one internal MCP server you already have. Ask it for a small report. Open the report and follow one footnote back to the exact call that produced it. Then try to make it reach an endpoint you didn't declare — and watch it refuse, and log the refusal.

That's the whole product, in one afternoon. **An AI assistant your security team won't have to carve an exception for, and a report you can actually stand behind.**

The full guide — quickstart, architecture, configuration, the security model, the report formats, the CLI, the plugin, standalone mode, and troubleshooting — is in the repo under [`guide/`](../guide/README.md). Start at the [Quickstart](../guide/quickstart.md) if you just want a first successful run.

Sandy. SANDBOXable AI. Your data stays home.
