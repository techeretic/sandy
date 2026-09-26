# Sandy in the stacks: a field test of v0.2.1 against the Library of Congress

*An exploratory, warts-and-all walkthrough: taking a public MCP server from a marketplace listing to a provenance-tracked report, inside a sandbox on a Mac. What worked, what surprised us, and what we're going to fix.*

> **Update (same day):** all eight findings below have been fixed on `master` (PRs #51–#58, after v0.2.1). The walkthrough is left as it happened; see [the fixes](#update-the-fixes) at the end for what changed and what the same session looks like now.
>
> **Update (2026-09-26):** released in **v0.3.0**, together with four more fixes found re-running this test on Linux in a read-only Docker container. The most important is a security fix: on a Linux host running Docker, v0.2.1 mistook the bare host for a `docker` sandbox. The others: a stdio server's stderr is now drained and shown when it fails to start, and `ask` no longer drops or crashes on report re-writes.

---

The [product post](sandy.md) makes Sandy's pitch in the abstract: an assistant that lives inside a boundary it can prove it can't leave, talks only to MCP servers you declare, and writes reports where every claim traces back to a source call. This post tests that pitch on one concrete task, with nothing prepared in advance.

The task was: *take an MCP server we'd never seen, found on a marketplace, and use the latest Sandy (v0.2.1) to get a trustworthy report out of it.*

The server we picked is the [Library of Congress MCP server](https://mcpmarket.com/server/library-of-congress) ([`@cyanheads/libofcongress-mcp-server`](https://github.com/cyanheads/libofcongress-mcp-server)). It's a good test subject for three reasons:

- **It's real and public.** Six read-only tools cover LOC's digital collections, the Chronicling America newspaper archive (with full OCR text), and LC Subject Headings (LCSH). No API key is needed.
- **It's slow and rate-limited.** LOC allows about 20 requests a minute, and the server deliberately waits about 3.1s between calls. Timeouts and retries will actually happen.
- **Its data is messy.** Newspaper OCR from 1918 reads like `OTTAWA FREE TRAnEK-JOUILVAE`. A report built on this kind of data has to show where each line came from, because you can't take it at face value.

Our research question was deliberately small: **how did American newspapers and the Library's collections record the 1918 influenza pandemic?**

## Step 0: A sandbox on a laptop

Sandy refuses to start without a boundary. On a Mac there's no Docker or Firejail by default, but macOS ships its own sandbox, **Seatbelt**, which you drive with `sandbox-exec`.

This was our first finding. Sandy's config schema lists `macos-sandbox-exec` as a valid `sandbox.runtime`, **but the runtime detector can't recognize it yet**. Declare it and Sandy refuses to start with exit `4`, even when it really is running under `sandbox-exec`. The documented escape hatch is `runtime: "custom"`, which means *"I, the operator, own this boundary."* Sandy accepts that, reports itself as `DEGRADED`, and says why:

```
  sandbox:     none (declared: custom)
  capability:  reduced mode: 1 capability loss(es) — no sandbox runtime detected; ...
  RESULT: DEGRADED
```

That honesty is correct. Sandy can't verify a custom boundary, so it says so, and it records a `sandbox_violation` event in the audit log on every start. (The message still says "refusing to continue", but with `custom` it continues. The wording needs fixing.)

Here's the Seatbelt profile we used. It allows writes only to the working root, the audit log, the server's log directory, and temp. It denies reads of the usual credential stores, and it allows only HTTPS out plus the local DNS resolver:

```scheme
(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath "~/sandy-loc/workspace")
  (literal "~/sandy-loc/audit.jsonl")
  (subpath "~/sandy-loc/server-logs")
  (subpath "/private/tmp") (subpath "/private/var/folders")
  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))
(deny file-read* (subpath "~/.ssh") (subpath "~/.aws") (subpath "~/.config/gh"))
(deny network-outbound)
(allow network-outbound (remote tcp "*:443"))
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
```

(Seatbelt wants absolute paths. We've written `~` here for readability.)

We didn't just trust the profile. We checked that it bites:

```
write outside root: EPERM
read ~/.ssh:        EPERM
http :80:           EPERM
```

> **An important nuance about stdio servers.** Sandy's own egress guard (the *NetworkGuard*) covers every network MCP transport (`sse`, `http`): nothing leaves unless its `host:port` is in `sandbox.allowed_network`. A **stdio** server is different. It's a child process that makes its own outbound calls (here, to `loc.gov`, `id.loc.gov`, and `tile.loc.gov`), and Sandy doesn't proxy them. For a stdio server, **the outer boundary is the egress control**. That's exactly why Sandy insists on having one. If you'd rather Sandy's guard mediate every byte, this server also has a hosted Streamable-HTTP endpoint. Declare it as `transport: "http"` and add its host to `allowed_network`.

## Step 1: `sandy import`, the headline v0.2 feature

v0.2.0 added `sandy import <url|file|->`. Point it at something that describes an MCP server, and it produces a **validated, content-hash-pinned, staged** config entry that you review before anything goes live. The obvious first move was to feed it the marketplace URL:

```bash
$ sandy import https://mcpmarket.com/server/library-of-congress -c sandy.json --yes
sandy import: will dial (one-shot, audited) GET https://mcpmarket.com/server/library-of-congress
error: fetch failed: HTTP 403 for https://mcpmarket.com/server/library-of-congress
```

The marketplace blocks non-browser clients. That's fine: it's a prose page anyway, and v1 of `import` is deliberately **deterministic-only**. The design would have rejected it one step later, with a pointer to the deferred `--auto` (LLM-transcription) path.

Next we tried the server's own `server.json`, which is in the official MCP Registry format:

```bash
$ sandy import https://raw.githubusercontent.com/cyanheads/libofcongress-mcp-server/main/server.json --yes
error: invalid MCP server manifest from https://raw.githubusercontent.com/...:
  - servers: Invalid input: expected array, received undefined
  - (root): Unrecognized keys: "$schema", "name", "description", "repository", "version", "remotes", "packages"
exit=3
```

That's a **fail-closed rejection**, which is what the design promises: *nothing is legal because a URL said so*. It also shows where the next win is. Registry `server.json` files are becoming the standard way servers describe themselves, and a deterministic converter from `server.json` to Sandy's manifest would make `import` work with nearly any published server. The design doc already lists this as an open question.

So we wrote the manifest ourselves, in Sandy's native schema. It takes about 30 lines. Note the **exact version pin**, the **env-ref-only** environment, and the **explicit allowlist**:

```json
{
  "servers": [{
    "name": "loc",
    "transport": "stdio",
    "command": ["node", "~/sandy-loc/server/node_modules/@cyanheads/libofcongress-mcp-server/dist/index.js"],
    "env": { "LOC_USER_AGENT": "${LOC_USER_AGENT}", "LOGS_DIR": "${LOC_LOGS_DIR}" },
    "version": "0.3.0",
    "capabilities": [
      "libofcongress_search", "libofcongress_get_item",
      "libofcongress_search_newspapers", "libofcongress_get_newspaper_page",
      "libofcongress_search_subjects", "libofcongress_browse_collections"
    ],
    "allowed_tools": [ "...all six: every tool is read-only..." ]
  }]
}
```

We installed the server package locally at an exact version (`npm i --save-exact @cyanheads/libofcongress-mcp-server@0.3.0`) instead of using the README's `npx -y ...@latest`. A `@latest` in a `command` would quietly defeat Sandy's `version` pin.

Then we staged it:

```
$ sandy import ./loc-manifest.json -c sandy.json
Sandy import
  source:  ./loc-manifest.json
  sha256:  f0633bca…
  staged:  ~/sandy-loc/.sandy-import/f0633bca….json
  servers:
    • loc (stdio) — allows libofcongress_search, … of 6 exposed
  export env vars (names only, values never staged):
    export LOC_USER_AGENT="..."
    export LOC_LOGS_DIR="..."
  allowlist: confirm the tools above, or re-run with --tools <server=a,b>
  applied: no — review the staged file, then re-run with --apply
```

We ran this from outside the config directory, and the staging directory landed **next to `sandy.json`**, not in our current directory. That's one of the three v0.2.1 fixes, working as intended.

Two more behaviors are worth knowing:

- **`--apply` can't add your *first* server.** It re-runs the full config load as its final gate, so it needs an existing `mcp-servers.json`, and the schema requires at least one server. On a fresh setup, you promote the staged `manifest` block by hand. That's the documented "or edit config yourself" path, but a bootstrap mode would be kinder to first-time users.
- **Re-importing a changed manifest is a fresh, reviewable event.** Changing one env var produced a new content hash and a new staged file. Trying to `--apply` it over the existing `loc` server was a hard refusal: `server "loc" already exists … import refuses to overwrite existing servers`. That's correct behavior. Updates are diffs that you review, never silent overwrites.

## Step 2: The first run, and a quiet crash

```bash
$ export LOC_USER_AGENT="sandy-demo/0.2.1 (+https://github.com/techeretic/sandy)"
$ sandbox-exec -f sandy.sb sandy check -c sandy.json
  MCP servers:
    ✓ loc — connected
```

The server connected. Then we ran the first request:

```
→ subjects: loc/libofcongress_search_subjects
✗ subjects: … failed: MCP error -32000: Connection closed
✗ photos:   … failed: Not connected
✗ papers:   … failed: Not connected
• done: 0 claim(s), 3 gap(s)
```

That's zero claims and three gaps. **This is Sandy working correctly.** The report was still written, and it said plainly that nothing came back and why. It didn't invent a single sentence about the 1918 flu.

The cause was a nice example of why you want a sandbox around third-party code. The server's framework writes log files into **its own package directory** (`node_modules/…/logs/`) by default. Seatbelt denied the write, and the process died on its first tool call. Outside the sandbox the same server worked perfectly, *and scribbled into `node_modules`*. The fix was to point it somewhere legitimate: `LOGS_DIR` → `~/sandy-loc/server-logs`, which is the one extra writable path in the profile.

## Step 3: A real report

```
→ subjects: loc/libofcongress_search_subjects   ✓ (535ms)
→ photos:   loc/libofcongress_search             ✓ (1820ms)
→ papers:   loc/libofcongress_search_newspapers  ✓ (39564ms)
• done: 6 claim(s), 0 gap(s)
```

Look at that 39.5 seconds. The audit log explains it without us having to guess:

```json
{"type":"mcp_call","data":{"tool":"libofcongress_search_newspapers","durationMs":30002,"outcome":"error","error":"MCP error -32001: Request timed out"}}
{"type":"mcp_call","data":{"tool":"libofcongress_search_newspapers","durationMs":9311,"outcome":"ok"}}
```

The first attempt hit the 30-second MCP timeout. Sandy retried, and the second attempt succeeded in 9.3 seconds. Both attempts are recorded, with a hash of the arguments rather than the arguments themselves, because `audit_payload_logging` is off.

The content was worth the wait:

- **23 photographs** from 1918–19, including the *St. Louis Red Cross Motor Corps on duty, Oct. 1918*: "mask-wearing women holding stretchers at backs of ambulances."
- **15,105 newspaper pages** from Sept–Dec 1918 matching "influenza schools closed", from the *Vashon Island Record* (WA) to the *Barre Daily Times* (VT) to the *Ottawa Free Trader-Journal* (IL). The Ottawa page's local notes report residents "iI with the Seauisl influenza". That's OCR for *Spanish*, and a reminder that you want every line traceable to the scan it came from.

Each block in the report carries a footnote marker, and a **Provenance** table maps every reference to its server, tool, argument hash, and timestamp.

## Step 4: Iterate, then save the request as a template

The first run also held a quiet lesson. Our subject query, `"influenza epidemic 1918"`, returned **0 LCSH headings**, and the server's recovery hint explained why: LCSH uses inverted forms. The second pass found the controlled heading, **`Influenza Epidemic, 1918-1919`** (`sh2003011372`).

This is where saved templates (`templates.json`) earn their keep. We wrote `flu-1918-deep` to resolve the heading, search within it, pull the full record for the Motor Corps photo, and fetch the OCR text of the Ottawa page:

```bash
$ sandbox-exec -f sandy.sb sandy run flu-1918-deep -c sandy.json
```

It took three runs to get right, and each failure was informative:

1. **A gap, reported honestly.** We left `query` out of the subject-scoped search. The server rejected the call, and Sandy put it in the report's **Gaps** section verbatim, including the server's own recovery hint: *"Recovery: Provide query. (reason invalid_arguments)"*. The other three tasks still succeeded.
2. **A "successful" empty result.** With the exact LCSH heading as the `subject` filter, LOC returned `0 total`. This one landed in the report as a *claim*, not a gap, because Sandy only counts a result as empty when the server returns no text at all. The report doesn't hide it; it says `0 total` right there. But you have to read the claim to notice it's a miss.
3. **Success.** The item records turned out to index the facet in lowercase (`influenza epidemic`). With that fix: **33 items**, including the *Brett Riggs influenza pandemic archive, 1891–1945* (a manuscript collection of letters, diaries, and clippings), a 1919 book titled *Spanish influenza (pan-asthenia): its cause and cure*, and an *Investigation of influenza*, "ordered to be printed" on October 1, 1919.

The template is now a one-word, repeatable, schema-validated request. It can't call anything the allowlist doesn't permit, and it can't be edited into doing so.

## Step 5: Other formats

Setting `preferences.default_report_format: "pdf"` and naming the report file `flu-1918-deep.pdf` produced a 5-page PDF of the same claims, gaps, and provenance. It was written as a byte-exact artifact through Sandy's sandboxed File Manager.

We also tripped over something here, covered below: if you switch the default format to PDF but your template still says `file: "….md"`, **no report is written, and the human-readable CLI output doesn't tell you**.

## What we learned

**The core promises held up against a server we'd never seen.** Every call went through the allowlist. Every failure became a gap or an audit event instead of made-up text. A timeout was retried and logged. The boundary blocked everything we probed. And the one thing that crashed was the third-party server trying to write where it shouldn't, which is exactly what a sandbox is for.

**`import` is strict in the right ways and not yet convenient enough.** Content hashing, staging, name-collision refusal, and never auto-expanding the allowlist all behaved exactly as designed. Getting value from it today still means writing Sandy's native manifest yourself.

**Our issue list from one afternoon:**

| # | Finding | Kind | Fixed in |
|---|---------|------|----------|
| 1 | A failed `import` fetch (e.g. HTTP 403) makes a network request but writes **no `import_fetch` audit event**, contrary to `IMPORT_DESIGN.md` ("Fetch failure — clean error, nothing staged, audit event recorded"). | Bug (audit gap) | [#51](https://github.com/techeretic/sandy/pull/51) |
| 2 | With a binary `default_report_format`, a request whose `report.file` ends in `.md` fails with `format-invalid`. The CLI prints no report line and no error, and exits `0`. The error appears only in the audit log and in `--json` `reportError`. | Bug (silent failure) | [#52](https://github.com/techeretic/sandy/pull/52) |
| 3 | Markdown footnotes don't pair up. Single-line claims get a reference (`[^1]`) with no definition, and multi-line claims get a definition with no reference. With real MCP output (nearly always multi-line), GitHub's renderer shows neither as links. The Provenance table still carries traceability. | Bug (rendering) | [#53](https://github.com/techeretic/sandy/pull/53) |
| 4 | `sandbox.runtime: "macos-sandbox-exec"` is accepted by the schema but never detected, so it always exits `4`. Use `custom` for now. | Gap | [#54](https://github.com/techeretic/sandy/pull/54) |
| 5 | `import --apply` can't bootstrap the first server into a missing or empty `mcp-servers.json`. | UX | [#55](https://github.com/techeretic/sandy/pull/55) |
| 6 | No deterministic converter from MCP Registry `server.json` to Sandy's manifest yet. | Feature | [#56](https://github.com/techeretic/sandy/pull/56) |
| 7 | The `DEGRADED` message for `custom` says "refusing to continue" but continues. | Wording | [#57](https://github.com/techeretic/sandy/pull/57) |
| 8 | Audit `seq` restarts at 1 on every invocation that appends to the same JSONL file, so `seq` alone isn't a global order. | Nit | [#58](https://github.com/techeretic/sandy/pull/58) |

None of these weakens the security story: no bypass, no undeclared egress, no fabrication. Two of them (#1 and #2) did weaken the *forensic* and *operator-feedback* story. All eight are now fixed; see the update below.

## Update: the fixes

One PR per finding, each with regression tests, merged the same day:

1. **A failed import fetch is audited.** `import_fetch` now carries `outcome: "ok"` or `outcome: "error"` with the error, so the 403 from the marketplace leaves a trace like any other dial.
2. **No more silent report failures.** A `report.file` that the configured format can't be written under (`.md` with `pdf`) is refused **before any MCP call** with exit `2`. Any other write failure prints `report: NOT WRITTEN — <reason>` and exits `1`.
3. **Footnotes link.** Each claim gets exactly one reference, and each reference has exactly one definition (server/tool, args hash, timestamp). Rendered through GitHub's Markdown API, all six footnotes from the report above are now live links.
4. **`macos-sandbox-exec` is detected.** The kernel won't let a process that's already under a restrictive Seatbelt profile apply a second sandbox, so Sandy runs a no-op nested `sandbox-exec` and treats `sandbox_apply: Operation not permitted` as the evidence. Under our profile, `sandy check` now says `sandbox: macos-sandbox-exec (declared: macos-sandbox-exec)` and `RESULT: OK`. A profile that denies nothing isn't detected, and that's the honest answer. The runtimes that still can't be detected (`systemd-nspawn`, `chroot`, `windows-appcontainer`) now get an error message pointing at `custom`.
5. **`--apply` bootstraps the first server** when `sandy.json` is valid but its manifest is missing or empty. A refused apply now restores both files byte-for-byte; before, it exited 3 but left the half-merged config on disk.
6. **`import` reads MCP Registry `server.json`.** The file that was rejected in Step 1 now imports. The registry format lists no tools and can offer both a hosted endpoint and a package, so Sandy asks instead of guessing: `--tools` is required, and so is `--registry-source` when both are present.
7. **`custom` says what's true:** "continuing under the declared custom boundary, which the operator manages — Sandy cannot verify it". It's still `DEGRADED`, and still audited.
8. **Every audit event carries a `session` id**, so `(session, seq)` identifies an event even when many runs share one JSONL file. We didn't continue `seq` from the file's tail, because that would race when two processes append at once.

The Step 1 dead end is now one command:

```bash
$ sandy import https://raw.githubusercontent.com/cyanheads/libofcongress-mcp-server/main/server.json \
    --tools libofcongress-mcp-server=libofcongress_search,libofcongress_get_item,… \
    --registry-source package --apply
  format:  MCP Registry server.json (converted; tools declared by you via --tools)
  applied: yes (live config updated + re-validated)
# → command: npx -y @cyanheads/libofcongress-mcp-server@0.3.0 run start:stdio   (exact version pin)
```

One caveat from trying it: the converted entry runs `npx`, which needs to write its package cache. Under our Seatbelt profile, which only allows writes to the workspace, the server fails to start with `startup failure (terminal)`, reported rather than hidden. You can either allow the npm cache directory in the profile, or do what we did above: install the pinned package locally and point `command` at it. The registry path gives you a reviewed, pinned entry quickly. How much the boundary lets that entry do is still your call.

## Try it yourself

Everything above runs on a stock Mac with Node ≥ 22 (the LOC server wants Node ≥ 24):

```bash
# 1. Sandy
git clone https://github.com/techeretic/sandy && cd sandy && npm ci && npm run build

# 2. The server, pinned
mkdir -p ~/sandy-loc/{server,workspace,server-logs} && cd ~/sandy-loc/server
npm init -y && npm i --save-exact @cyanheads/libofcongress-mcp-server@0.3.0

# 3. Config: sandy.json (runtime "custom", allowed_paths → ~/sandy-loc/workspace),
#    the manifest above, the Seatbelt profile above. Then stage and review:
cd ~/sandy-loc && node ~/sandy/bin/sandy.js import ./loc-manifest.json -c sandy.json

# 4. Run inside the boundary
export LOC_USER_AGENT="your-project/1.0 (+https://your.site)" LOC_LOGS_DIR=~/sandy-loc/server-logs
sandbox-exec -f sandy.sb node ~/sandy/bin/sandy.js check -c sandy.json
sandbox-exec -f sandy.sb node ~/sandy/bin/sandy.js run workspace/request.json -c sandy.json --audit audit.jsonl
```

Two courtesies: set a descriptive `LOC_USER_AGENT` (LOC asks for one), and keep `max_concurrent_mcp_calls` at `1`. The server already paces itself, and a 429 from LOC blocks you for an hour.

Then open the report, pick one claim, and follow it through the Provenance table to the exact call and timestamp that produced it. That's the point of Sandy: the report tells you where every line came from, including the ones that came back empty.
