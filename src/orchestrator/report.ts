import type { RenderReportInput } from "./orchestrator.js";
import type { Claim, Gap } from "./orchestrator.js";

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
  if (text.includes("\n")) {
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

function groupClaimsByTask(claims: Claim[]): Array<[string, Claim[]]> {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const list = groups.get(claim.source.task) ?? [];
    list.push(claim);
    groups.set(claim.source.task, list);
  }
  return [...groups.entries()];
}
