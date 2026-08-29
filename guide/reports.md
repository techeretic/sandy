# Reports

Sandy's output is a **report**: a deterministic rendering of the gathered **claims** and **gaps**, with full **provenance** — every claim footnoted to the exact source call that produced it. The report is the artifact you share; the provenance is what makes it *trustable* inside a compliance-bound workplace.

## The model: claims, gaps, provenance

A run produces two lists:

- **Claims** — each successful MCP call contributes one or more claims. A claim is `{ text, ref, source }` where `source` is the exact call: `server`, `tool`, `argsHash` (sha256 of the args), and `at` (timestamp). This is the provenance.
- **Gaps** — each failure is recorded as an explicit hole: `{ server, tool, task, reason, detail }`. Reasons are `server-unavailable`, `call-failed`, or `empty-result`. Gaps are **never smoothed over and never filled with invented data** — if a source didn't contribute, the report says so.

The report is a **function of `(claims, gaps)`** — no model is involved in the scaffolding, so it is stable, testable, and **cannot fabricate**. If there are no claims and gaps exist, the report states that the data was unavailable rather than inventing anything.

## The five formats

`preferences.default_report_format` sets the default for runs that don't specify a format. All five are implemented:

| Format | Type | Notes |
|--------|------|-------|
| `markdown` | text | The **source of truth**. Every other format is a deterministic view over the same `(claims, gaps)`. |
| `html` | text | A styled single-file page; all text HTML-escaped; claims link to their provenance row. |
| `docx` | **binary** | WordprocessingML in an OPC ZIP container. |
| `xlsx` | **binary** | SpreadsheetML — one worksheet per section. |
| `pdf` | **binary** | PDF 1.4, A4, base-14 Helvetica, word-wrapped paginated flow. |

**Content is identical across all five (SD-06); only the presentation differs.** Markdown is the source of truth, and every other format is a deterministic view over the same `(claims, gaps)` — the same claims, the same gaps, the same provenance entries, in the same order.

The three binary formats are **byte artifacts, not text**, so they are written through the File Manager's byte-exact `writeBinary` (magic-prefix validated: `PK` for docx/xlsx, `%PDF-` for pdf; journaled as base64 so undo is byte-exact). A text `write()` to a binary filename is refused fail-closed. The containers are **hand-rolled and zero-dependency** (a deterministic STORE ZIP with fixed timestamps + part order, so identical input → byte-identical archive).

A per-run `report` spec can override the default format via the filename extension (or the format is taken from `default_report_format`). The result carries the rendered content in-band: `reportContent` for text formats, `reportArtifactB64` (base64 bytes) for every format — so a binary report's on-disk bytes are available without re-reading the file.

### What a Markdown report looks like

```markdown
# Sprint Health

> **Goal:** Report the health of the current sprint in Jira
>
> _Generated 2026-08-29T09:00:00.000Z by Sandy. Every statement below is traceable to its source call in the Provenance section._

## Findings

### sprints

12 of 14 issues complete; 2 blocked on infra. [^1]

[^1]: source: `jira/read_sprints`

## Gaps

_The following sources did not contribute data. These holes are reported explicitly; they were not worked around._

- `jira/read_issues` (task `issues`) — **call failed**: 500

## Provenance

Every claim above references one of these source calls:

| Ref | Server | Tool | Args (sha256) | At |
|-----|--------|------|---------------|----|
| [1] | `jira` | `read_sprints` | `9f2c…e1` | 2026-08-29T09:00:00.000Z |
```

### Model narrative (clearly labeled)

An optional `summary` (the host LLM's narrative in plugin mode, or the local model's narrate in standalone) is rendered as a **Summary** section that is **explicitly labeled** as model prose:

> _(model narrative — a local/host model wrote this; it may vary in quality. The claims below are independently traceable and remain the source of truth.)_

The narrative is a convenience, not a second source of truth. The Findings/Provenance sections render directly from claim data with no model involvement.

## Writing reports

Reports are written **inside the working roots** (under `report_output_dir`) through the File Manager — the same confinement, confirmation, ignore-pattern, and undo-journal gates as any other file operation. Overwriting an existing report is confirmation-gated per `policy.confirmation_required`.

- **CLI:** `sandy run <request.json|template>` writes `reportOutputDir/<file>` (the `report.file` in the request).
- **Plugin:** `sandy.report` returns the report path + content.
- **Service:** `POST /run` enqueues a run; `GET /jobs/:id` returns the result; `GET /reports` lists the confined reports dir.

## Recurring report templates

A **template** is exactly an `orchestratorRequestSchema` object — the same shape `sandy run <request.json>` and `POST /run` take. A registry of named templates is an optional `templates: { "path": "./templates.json" }` in `sandy.json`:

```json
{
  "deals-emea": {
    "goal": "Summarize the EMEA deals currently in the CRM",
    "gather": [
      { "id": "deals", "server": "crm", "tool": "read_deals", "args": { "region": "emea" } }
    ],
    "report": { "title": "EMEA Deals", "file": "deals-emea.md" }
  }
}
```

The registry is loaded and **cross-checked against the manifest at config load** (an unknown server or a non-allowed tool is a `ConfigError` — fail closed). A template is re-run by name:

```bash
node bin/sandy.js run deals-emea -c sandy.json        # CLI
curl -X POST localhost:8080/run -d '{"template":"deals-emea"}'   # service
```

**Nothing is legal because a request is "saved."** A template run is validated by the *same* `orchestratorRequestSchema` + legal tool catalog as an ad-hoc request. `run` target resolution is fail-closed: a path that exists as a file is always the request file; otherwise the name is tried against the registry and only an exact match runs as a template; an unknown name is a usage error, never a silent guess. A template run is audited (`template_run`) and the job carries its `template`.

> **Scheduling is out of scope** by design: a template re-run "on a schedule" is the supervisor's job — a systemd/launchd/timer unit launching `sandy run <template>` — not a feature inside Sandy. See the [Configuration guide → templates](configuration.md).
