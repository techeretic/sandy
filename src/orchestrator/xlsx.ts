/**
 * Deterministic XLSX report rendering (issue #14).
 *
 * A view over the same (claims, gaps) as the Markdown, HTML, and DOCX
 * renderers: one worksheet per section — Summary (when present), Findings
 * (grouped by task, each claim in its own row with its ref), Gaps (explicit,
 * never smoothed over), and Provenance (one row per claim: ref, server, tool,
 * args hash, time). The content is identical across formats (SD-06); only the
 * presentation differs. All cell text is escaped for XML (inline strings);
 * the package is an OPC ZIP container written by {@link zipStore}.
 */

import type { RenderReportInput } from "./orchestrator.js";
import type { Claim, Gap } from "./orchestrator.js";
import { zipStore } from "./zip.js";
import { escapeXml } from "./xml.js";

/** Render the XLSX (SpreadsheetML) package bytes for a report. */
export function renderXlsxReport(input: RenderReportInput): Buffer {
  const sheets: Array<{ name: string; rows: string[][] }> = [];

  if (input.summary && input.summary.trim().length > 0) {
    sheets.push({
      name: "Summary",
      rows: [
        ["(model narrative — a local/host model wrote this; it may vary in quality. The claims below are independently traceable and remain the source of truth.)"],
        ...input.summary.trim().split("\n").map((line) => [line]),
      ],
    });
  }

  const findingsRows: string[][] = [
    [input.title],
    ["Goal", input.goal],
    ["Generated", `${input.generatedAt} by Sandy`],
    ["", ""],
    ["Task", "Ref", "Claim"],
  ];
  for (const [task, claims] of groupClaimsByTask(input.claims)) {
    for (const claim of claims) {
      findingsRows.push([task, String(claim.ref), claim.text]);
    }
  }
  if (input.claims.length === 0) {
    findingsRows.push(
      input.gaps.length > 0
        ? ["(no data could be retrieved — see Gaps; nothing is fabricated to fill the holes)"]
        : ["(no claims were gathered)"],
    );
  }
  sheets.push({ name: "Findings", rows: findingsRows });

  if (input.gaps.length > 0) {
    sheets.push({
      name: "Gaps",
      rows: [
        ["Task", "Server", "Tool", "Reason", "Detail"],
        ...input.gaps.map((gap: Gap) => [gap.task, gap.server, gap.tool, gap.reason.replace("-", " "), gap.detail]),
      ],
    });
  }

  sheets.push({
    name: "Provenance",
    rows: [
      ["Ref", "Server", "Tool", "Args (sha256)", "At"],
      ...input.claims.map((claim: Claim) => [
        String(claim.ref),
        claim.source.server,
        claim.source.tool,
        claim.source.argsHash,
        claim.source.at,
      ]),
    ],
  });

  const sheetParts = sheets.map((sheet, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: Buffer.from(worksheetXml(sheet.rows), "utf8"),
  }));

  const workbookSheets = sheets
    .map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${workbookSheets}</sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  return zipStore([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels, "utf8") },
    ...sheetParts,
  ]);
}

function worksheetXml(rows: string[][]): string {
  const body = rows
    .map((cells, r) => {
      const tcs = cells
        .map((cell, c) => {
          const ref = `${columnLetter(c + 1)}${r + 1}`;
          if (cell.length === 0) return `<c r="${ref}"/>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${tcs}</row>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
  );
}

/** 1 → "A", 2 → "B", …, 27 → "AA" (spreadsheet column letters). */
function columnLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
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
