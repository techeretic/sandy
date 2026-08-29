/**
 * Deterministic DOCX report rendering (issue #14).
 *
 * A view over the same (claims, gaps) as the Markdown and HTML renderers:
 * title, goal, the clearly-labeled summary (when present), findings grouped by
 * task, the explicit Gaps section, and the provenance table are all present —
 * the content is identical across formats (SD-06), only the presentation
 * differs. The package is an OPC ZIP container written by {@link zipStore};
 * all text is XML-escaped; multi-line claim text keeps its line breaks
 * (w:br), never collapsed.
 */

import type { RenderReportInput } from "./orchestrator.js";
import type { Claim, Gap } from "./orchestrator.js";
import { zipStore } from "./zip.js";
import { escapeXml } from "./xml.js";

/** Render the DOCX (WordprocessingML) package bytes for a report. */
export function renderDocxReport(input: RenderReportInput): Buffer {
  const body = documentBody(input);
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join("")}</w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  return zipStore([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
  ]);
}

function documentBody(input: RenderReportInput): string[] {
  const out: string[] = [];
  out.push(heading(1, input.title));
  out.push(paragraph([{ text: `Goal: ${input.goal}`, bold: true }]));
  out.push(
    paragraph([
      {
        text: `Generated ${input.generatedAt} by Sandy. Every statement below is traceable to its source call in the Provenance section.`,
        italic: true,
      },
    ]),
  );

  if (input.summary && input.summary.trim().length > 0) {
    out.push(heading(2, "Summary"));
    out.push(
      paragraph([
        {
          text: "(model narrative — a local/host model wrote this; it may vary in quality. The claims below are independently traceable and remain the source of truth.)",
          italic: true,
        },
      ]),
    );
    out.push(paragraph([{ text: input.summary.trim() }]));
  }

  const byTask = groupClaimsByTask(input.claims);
  out.push(heading(2, "Findings"));
  if (byTask.length > 0) {
    for (const [task, claims] of byTask) {
      out.push(heading(3, task));
      for (const claim of claims) {
        out.push(paragraph([{ text: claim.text }, { text: ` [${claim.ref}]`, color: "808080" }]));
      }
    }
  } else if (input.gaps.length > 0) {
    out.push(
      paragraph([
        { text: "No data could be retrieved.", bold: true },
        { text: " The reasons are listed in the Gaps section below. Nothing in this report is fabricated to fill the holes." },
      ]),
    );
  } else {
    out.push(paragraph([{ text: "No claims were gathered.", italic: true }]));
  }

  if (input.gaps.length > 0) {
    out.push(heading(2, "Gaps"));
    out.push(
      paragraph([
        {
          text: "The following sources did not contribute data. These holes are reported explicitly; they were not worked around.",
          italic: true,
        },
      ]),
    );
    for (const gap of input.gaps) {
      out.push(paragraph([{ text: renderGapText(gap) }]));
    }
  }

  out.push(heading(2, "Provenance"));
  if (input.claims.length === 0) {
    out.push(paragraph([{ text: "No claims, therefore no provenance entries.", italic: true }]));
  } else {
    out.push(provenanceTable(input.claims));
  }

  return out;
}

function renderGapText(gap: Gap): string {
  const badge = gap.reason.replace("-", " ");
  return `${gap.server}/${gap.tool} (task ${gap.task}) — ${badge}: ${gap.detail}`;
}

/** Run = a styled text fragment; line breaks inside the text become w:br. */
interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
}

function runXml(run: Run): string {
  let rPr = "";
  if (run.bold) rPr += "<w:b/>";
  if (run.italic) rPr += "<w:i/>";
  if (run.color) rPr += `<w:color w:val="${run.color}"/>`;
  const rPrXml = rPr ? `<w:rPr>${rPr}</w:rPr>` : "";
  const segments = escapeXml(run.text).split("\n");
  const runs = segments
    .map((seg, i) => (i > 0 ? "<w:br/>" : "") + (seg.length > 0 ? `<w:t xml:space="preserve">${seg}</w:t>` : ""))
    .join("");
  return `<w:r>${rPrXml}${runs}</w:r>`;
}

function paragraph(runs: Run[], style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${pPr}${runs.map(runXml).join("")}</w:p>`;
}

function heading(level: 1 | 2 | 3, text: string): string {
  return paragraph([{ text, bold: true }], `Heading${level}`);
}

/** The provenance table: one row per claim (ref, server, tool, args hash, time). */
function provenanceTable(claims: Claim[]): string {
  const header = ["Ref", "Server", "Tool", "Args (sha256)", "At"];
  const rows: string[][] = [header];
  for (const claim of claims) {
    rows.push([
      String(claim.ref),
      claim.source.server,
      claim.source.tool,
      claim.source.argsHash,
      claim.source.at,
    ]);
  }
  const borders =
    "<w:tblBorders>" +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`)
      .join("") +
    "</w:tblBorders>";
  const trs = rows
    .map((cells, i) => {
      const tcs = cells
        .map((cell) => `<w:tc><w:p>${runXml({ text: cell, bold: i === 0 })}</w:p></w:tc>`)
        .join("");
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr>${borders}</w:tblPr>${trs}</w:tbl>`;
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
