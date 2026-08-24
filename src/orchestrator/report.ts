import type { RenderReportInput } from "./orchestrator.js";
import type { Claim, Gap } from "./orchestrator.js";

/**
 * The report formats Sandy can render (issue #14).
 *
 * The Markdown renderer is the source of truth (RG-02/04/05): every other
 * format is a deterministic *view* over the same (claims, gaps) structure, so
 * the content — every claim, gap, and provenance entry — is identical across
 * formats (SD-06); only the presentation changes.
 */
export const REPORT_FORMATS = ["markdown", "html"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** File extension for each supported report format. */
const REPORT_FORMAT_EXTENSION: Record<ReportFormat, string> = {
  markdown: ".md",
  html: ".html",
};

/** The file extension a report should be written under, per format. */
export function reportFormatExtension(format: ReportFormat): string {
  return REPORT_FORMAT_EXTENSION[format];
}

/**
 * Format dispatcher (issue #14): render a report in the requested format.
 *
 * Markdown is the source of truth; HTML is a lightweight, deterministic
 * transform of the same (claims, gaps). The config also declares docx/xlsx/
 * pdf, which are not implemented here — they are refused fail-closed by the
 * config loader (an unimplemented format is a config error, never a silent
 * Markdown fallback).
 */
export function renderReport(format: ReportFormat, input: RenderReportInput): string {
  switch (format) {
    case "markdown":
      return renderMarkdownReport(input);
    case "html":
      return renderHtmlReport(input);
    default:
      // Exhaustiveness: the union is closed, so this is unreachable.
      throw new Error(`unreachable report format: ${String(format)}`);
  }
}

/**
 * Deterministic Markdown report rendering (RG-02, RG-04, RG-05).
 *
 * The report is a function of (claims, gaps) — no model involved in the
 * scaffolding, so it is stable, testable, and cannot fabricate:
 *
 *  - every claim carries a footnote resolving to the exact source tool call
 *    (server, tool, args hash, timestamp) — provenance (RG-04);
 *  - gaps get their own section, never smoothed over (RG-05);
 *  - if there are no claims and gaps exist, the report says the data was
 *    unavailable instead of inventing anything (RG-06).
 *
 * The optional `summary` is host-LLM narrative supplied by the caller; it is
 * clearly labeled as such and is not the only source of truth.
 */
export function renderMarkdownReport(input: RenderReportInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.title}`);
  lines.push("");
  lines.push(`> **Goal:** ${input.goal}`);
  lines.push(`>`);
  lines.push(`> _Generated ${input.generatedAt} by Sandy. Every statement below is traceable to its source call in the Provenance section._`);
  lines.push("");

  if (input.summary && input.summary.trim().length > 0) {
    lines.push("## Summary");
    lines.push("");
    lines.push(`_(model narrative — a local/host model wrote this; it may vary in quality. The claims below are independently traceable and remain the source of truth.)_`);
    lines.push("");
    lines.push(input.summary.trim());
    lines.push("");
  }

  const byTask = groupClaimsByTask(input.claims);
  if (byTask.length > 0) {
    lines.push("## Findings");
    lines.push("");
    for (const [task, claims] of byTask) {
      const first = claims[0] as Claim;
      lines.push(`### ${task}`);
      lines.push("");
      for (const claim of claims) {
        lines.push(renderClaimLine(claim));
      }
      lines.push("");
    }
  } else {
    lines.push("## Findings");
    lines.push("");
    if (input.gaps.length > 0) {
      lines.push("**No data could be retrieved.** The reasons are listed in the Gaps section below. Nothing in this report is fabricated to fill the holes.");
    } else {
      lines.push("_No claims were gathered._");
    }
    lines.push("");
  }

  if (input.gaps.length > 0) {
    lines.push("## Gaps");
    lines.push("");
    lines.push("_The following sources did not contribute data. These holes are reported explicitly; they were not worked around._");
    lines.push("");
    for (const gap of input.gaps) {
      lines.push(renderGapLine(gap));
    }
    lines.push("");
  }

  lines.push("## Provenance");
  lines.push("");
  if (input.claims.length === 0) {
    lines.push("_No claims, therefore no provenance entries._");
  } else {
    lines.push("Every claim above references one of these source calls:");
    lines.push("");
    lines.push("| Ref | Server | Tool | Args (sha256) | At |");
    lines.push("|-----|--------|------|---------------|----|");
    for (const claim of input.claims) {
      lines.push(
        `| [${claim.ref}] | \`${claim.source.server}\` | \`${claim.source.tool}\` | \`${claim.source.argsHash}\` | ${claim.source.at} |`,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

function renderClaimLine(claim: Claim): string {
  // Preserve the source text, appending the footnote. Multi-line text gets a
  // blockquote so the footnote stays attached to the last line.
  const text = claim.text;
  if (isMultiLine(text)) {
    const quoted = text
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    return `${quoted}\n\n[^${claim.ref}]: source: \`${claim.source.server}/${claim.source.tool}\``;
  }
  return `${text} [^${claim.ref}]`;
}

function renderGapLine(gap: Gap): string {
  const badge = gap.reason.replace("-", " ");
  return `- \`${gap.server}/${gap.tool}\` (task \`${gap.task}\`) — **${badge}**: ${gap.detail}`;
}

function isMultiLine(text: string): boolean {
  return text.includes("\n");
}

function groupClaimsByTask(claims: Claim[]): Array<[string, Claim[]]> {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const list = groups.get(claim.source.task) ?? [];
    list.push(claim);
    groups.set(claim.source.task, list);
  }
  return [...groups.entries()];
}

/**
 * Deterministic HTML report rendering (issue #14). A lightweight view over the
 * same (claims, gaps) as {@link renderMarkdownReport}: the goal, summary
 * (clearly labeled), findings, gaps, and the provenance table are all present,
 * so the content is identical to the Markdown report — only the presentation
 * differs (SD-06). Every claim keeps its source reference; gaps are never
 * smoothed over (RG-05); an empty result says the data was unavailable
 * (RG-06).
 */
export function renderHtmlReport(input: RenderReportInput): string {
  const out: string[] = [];
  out.push("<!DOCTYPE html>");
  out.push('<html lang="en">');
  out.push("<head>");
  out.push('<meta charset="utf-8" />');
  out.push(`<title>${escapeHtml(input.title)}</title>`);
  out.push("<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem;line-height:1.5}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:.25rem .5rem;text-align:left}code{background:#f2f2f2;padding:.1rem .25rem}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:1rem;color:#444}.gap{color:#8a2}.note{color:#555;font-style:italic}</style>");
  out.push("</head>");
  out.push("<body>");
  out.push(`<h1>${escapeHtml(input.title)}</h1>`);
  out.push(`<p><strong>Goal:</strong> ${escapeHtml(input.goal)}</p>`);
  out.push(`<p class="note">Generated ${escapeHtml(input.generatedAt)} by Sandy. Every statement below is traceable to its source call in the Provenance section.</p>`);

  if (input.summary && input.summary.trim().length > 0) {
    out.push("<h2>Summary</h2>");
    out.push('<p class="note">(model narrative — a local/host model wrote this; it may vary in quality. The claims below are independently traceable and remain the source of truth.)</p>');
    out.push(`<p>${escapeHtml(input.summary.trim())}</p>`);
  }

  const byTask = groupClaimsByTask(input.claims);
  out.push("<h2>Findings</h2>");
  if (byTask.length > 0) {
    for (const [task, claims] of byTask) {
      out.push(`<h3>${escapeHtml(task)}</h3>`);
      for (const claim of claims) {
        out.push(renderHtmlClaim(claim));
      }
    }
  } else if (input.gaps.length > 0) {
    out.push("<p><strong>No data could be retrieved.</strong> The reasons are listed in the Gaps section below. Nothing in this report is fabricated to fill the holes.</p>");
  } else {
    out.push("<p><em>No claims were gathered.</em></p>");
  }

  if (input.gaps.length > 0) {
    out.push("<h2>Gaps</h2>");
    out.push('<p class="note">The following sources did not contribute data. These holes are reported explicitly; they were not worked around.</p>');
    out.push("<ul>");
    for (const gap of input.gaps) {
      const badge = gap.reason.replace("-", " ");
      out.push(`<li class="gap"><code>${escapeHtml(gap.server)}/${escapeHtml(gap.tool)}</code> (task <code>${escapeHtml(gap.task)}</code>) — <strong>${escapeHtml(badge)}</strong>: ${escapeHtml(gap.detail)}</li>`);
    }
    out.push("</ul>");
  }

  out.push("<h2>Provenance</h2>");
  if (input.claims.length === 0) {
    out.push("<p><em>No claims, therefore no provenance entries.</em></p>");
  } else {
    out.push("<p>Every claim above references one of these source calls:</p>");
    out.push("<table>");
    out.push("<thead><tr><th>Ref</th><th>Server</th><th>Tool</th><th>Args (sha256)</th><th>At</th></tr></thead>");
    out.push("<tbody>");
    for (const claim of input.claims) {
      out.push(
        `<tr id="prov-${claim.ref}"><td>${claim.ref}</td><td><code>${escapeHtml(claim.source.server)}</code></td><td><code>${escapeHtml(claim.source.tool)}</code></td><td><code>${escapeHtml(claim.source.argsHash)}</code></td><td>${escapeHtml(claim.source.at)}</td></tr>`,
      );
    }
    out.push("</tbody>");
    out.push("</table>");
  }

  out.push("</body>");
  out.push("</html>");
  return out.join("\n");
}

/** Render a single HTML claim, preserving its text (multi-line kept intact) and its source reference. */
function renderHtmlClaim(claim: Claim): string {
  const body = isMultiLine(claim.text)
    ? `<blockquote>${escapeHtml(claim.text)}</blockquote>`
    : escapeHtml(claim.text);
  return `<p>${body} <a href="#prov-${claim.ref}" id="claim-${claim.ref}">[${claim.ref}]</a></p>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
