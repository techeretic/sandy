/**
 * Deterministic PDF report rendering (issue #14).
 *
 * A view over the same (claims, gaps) as the Markdown, HTML, DOCX, and XLSX
 * renderers: title, goal, the clearly-labeled summary (when present), findings
 * grouped by task, the explicit Gaps section, and a provenance entry per claim
 * (ref, server, tool, args hash, task, time) are all present — the content is
 * identical across formats (SD-06); only the presentation differs.
 *
 * The document is a minimal, dependency-free PDF 1.4: A4 pages, the base-14
 * Helvetica family (regular/bold/oblique) with WinAnsiEncoding, word-wrapped
 * text, and a paginated flow (sections flow to a new page when they do not fit;
 * a provenance entry is never split across pages). Text outside WinAnsi is
 * substituted with "?" — the report's content is ASCII-safe in practice, and a
 * viewer-faithful fallback is preferable to an invalid byte.
 */

import type { RenderReportInput } from "./orchestrator.js";
import type { Claim, Gap } from "./orchestrator.js";

// A4 in points, margins, and the fixed layout metrics (determinism: the same
// (claims, gaps) always flow to the same pages).
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 50;
const MARGIN_TOP = 60;
const MARGIN_BOTTOM = 60;
const LEADING = 1.25;

type FontKey = "F1" | "F2" | "F3";

/** One flow block: pre-wrapped lines in a single font/size, never split. */
interface FlowItem {
  lines: string[];
  size: number;
  font: FontKey;
  indent: number;
  spaceBefore: number;
  spaceAfter: number;
}

/** Render the PDF document bytes for a report. */
export function renderPdfReport(input: RenderReportInput): Buffer {
  const items = buildFlow(input);
  const pages = flowPages(items);

  const fontObjs: Array<{ num: number; body: () => string }> = [];
  const objects: Array<{ num: number; body: string }> = [];

  // Object numbers: 1 catalog, 2 pages, 3 F1, 4 F2, 5 F3, then per page i a
  // page object (6 + 2i) and its content stream (7 + 2i) — no collisions.
  const pageObjNum = (i: number) => 6 + 2 * i;
  const contentObjNum = (i: number) => 7 + 2 * i;

  const pageKids = pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(" ");
  objects.push({
    num: 1,
    body: "<< /Type /Catalog /Pages 2 0 R >>",
  });
  objects.push({
    num: 2,
    body: `<< /Type /Pages /Kids [${pageKids}] /Count ${pages.length} >>`,
  });
  objects.push({
    num: 3,
    body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  });
  objects.push({
    num: 4,
    body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  });
  objects.push({
    num: 5,
    body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>",
  });

  const pageBodies = pages.map((page, i) => {
    const ops: string[] = [];
    for (const cmd of page.commands) {
      ops.push(cmd);
    }
    // Footer (page number), centered near the bottom.
    const footer = `Page ${i + 1} of ${pages.length}`;
    const footerX = (PAGE_W - footer.length * 8 * 0.5) / 2;
    ops.push(`BT /F1 8 Tf ${fmt(footerX)} 30 Td ${pdfString(footer)} Tj ET`);
    const stream = ops.join("\n");
    return {
      num: pageObjNum(i),
      body:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(PAGE_W)} ${fmt(PAGE_H)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> ` +
        `/Contents ${contentObjNum(i)} 0 R >>`,
      stream,
    };
  });

  for (const [i, page] of pageBodies.entries()) {
    objects.push({ num: page.num, body: page.body });
    objects.push({
      num: contentObjNum(i),
      body: `<< /Length ${Buffer.byteLength(page.stream, "latin1")} >>\nstream\n${page.stream}\nendstream`,
    });
  }

  return assemblePdf(objects);
}

// --- flow -------------------------------------------------------------------

function buildFlow(input: RenderReportInput): FlowItem[] {
  const usable = PAGE_W - 2 * MARGIN_X;
  const items: FlowItem[] = [];
  const add = (text: string, size: number, font: FontKey, opts: Partial<FlowItem> = {}): void => {
    items.push({
      lines: wrap(text, Math.max(1, Math.floor((usable - (opts.indent ?? 0)) / (size * 0.5)))),
      size,
      font,
      indent: opts.indent ?? 0,
      spaceBefore: opts.spaceBefore ?? 0,
      spaceAfter: opts.spaceAfter ?? 2,
    });
  };

  add(input.title, 18, "F2", { spaceBefore: 0, spaceAfter: 10 });
  add(`Goal: ${input.goal}`, 11, "F1", { spaceAfter: 2 });
  add(
    `Generated ${input.generatedAt} by Sandy. Every statement below is traceable to its source call in the Provenance section.`,
    9,
    "F3",
    { spaceAfter: 8 },
  );

  if (input.summary && input.summary.trim().length > 0) {
    add("Summary", 14, "F2", { spaceAfter: 2 });
    add(
      "(model narrative — a local/host model wrote this; it may vary in quality. The claims below are independently traceable and remain the source of truth.)",
      9,
      "F3",
      { spaceAfter: 2 },
    );
    add(input.summary.trim(), 11, "F1", { spaceAfter: 8 });
  }

  add("Findings", 14, "F2", { spaceBefore: 4, spaceAfter: 2 });
  const byTask = groupClaimsByTask(input.claims);
  if (byTask.length > 0) {
    for (const [task, claims] of byTask) {
      add(task, 12, "F2", { spaceBefore: 2, spaceAfter: 2 });
      for (const claim of claims) {
        add(`${claim.text} [${claim.ref}]`, 11, "F1", { indent: 14, spaceAfter: 3 });
      }
    }
  } else if (input.gaps.length > 0) {
    add(
      "No data could be retrieved. The reasons are listed in the Gaps section below. Nothing in this report is fabricated to fill the holes.",
      11,
      "F1",
      { spaceAfter: 8 },
    );
  } else {
    add("No claims were gathered.", 11, "F3", { spaceAfter: 8 });
  }

  if (input.gaps.length > 0) {
    add("Gaps", 14, "F2", { spaceBefore: 4, spaceAfter: 2 });
    add(
      "The following sources did not contribute data. These holes are reported explicitly; they were not worked around.",
      9,
      "F3",
      { spaceAfter: 2 },
    );
    for (const gap of input.gaps) {
      const badge = gap.reason.replace("-", " ");
      add(`${gap.server}/${gap.tool} (task ${gap.task}) — ${badge}: ${gap.detail}`, 10, "F1", { indent: 14, spaceAfter: 3 });
    }
  }

  add("Provenance", 14, "F2", { spaceBefore: 4, spaceAfter: 2 });
  if (input.claims.length === 0) {
    add("No claims, therefore no provenance entries.", 11, "F3", { spaceAfter: 2 });
  } else {
    for (const claim of input.claims) {
      // Two lines per claim, kept together (an item is never split across
      // pages): the source call, then the full args hash.
      items.push({
        lines: [
          `[${claim.ref}] ${claim.source.server}/${claim.source.tool} (task: ${claim.source.task}) at ${claim.source.at}`,
          `args: ${claim.source.argsHash}`,
        ],
        size: 9,
        font: "F1",
        indent: 0,
        spaceBefore: 0,
        spaceAfter: 5,
      });
    }
  }

  return items;
}

interface PageCommands {
  commands: string[];
}

function flowPages(items: FlowItem[]): PageCommands[] {
  const pages: PageCommands[] = [];
  let y = PAGE_H - MARGIN_TOP;
  let current: PageCommands = { commands: [] };

  const height = (item: FlowItem): number =>
    item.spaceBefore + item.lines.length * item.size * LEADING + item.spaceAfter;

  const flushIfNeeded = (item: FlowItem): void => {
    if (y - height(item) < MARGIN_BOTTOM) {
      pages.push(current);
      current = { commands: [] };
      y = PAGE_H - MARGIN_TOP;
    }
  };

  for (const item of items) {
    flushIfNeeded(item);
    y -= item.spaceBefore;
    for (const line of item.lines) {
      const x = MARGIN_X + item.indent;
      current.commands.push(`BT /${item.font} ${item.size} Tf ${fmt(x)} ${fmt(y)} Td ${pdfString(line)} Tj ET`);
      y -= item.size * LEADING;
    }
    y -= item.spaceAfter;
  }
  pages.push(current);
  return pages;
}

/** Word-wrap to a fixed character budget (the width model is size * 0.5/char). */
function wrap(text: string, charsPerLine: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      out.push("");
      continue;
    }
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length <= charsPerLine) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
        // A single word longer than the line budget is hard-broken across
        // lines — text is never dropped.
        if (word.length > charsPerLine) {
          while (line.length > charsPerLine) {
            out.push(line.slice(0, charsPerLine));
            line = line.slice(charsPerLine);
          }
        }
      }
    }
    out.push(line);
  }
  return out;
}

// --- PDF assembly -------------------------------------------------------------

/** Format a number with up to 2 decimal places (deterministic, no float noise). */
function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/**
 * Encode a string for a PDF literal in WinAnsiEncoding: escape the PDF
 * metacharacters and map the text to the WinAnsi byte alphabet (characters
 * outside it become "?").
 */
function pdfString(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    const byte = winAnsiByte(cp);
    if (byte === 0x5c) out += "\\\\";
    else if (byte === 0x28) out += "\\(";
    else if (byte === 0x29) out += "\\)";
    else out += String.fromCharCode(byte);
  }
  return `(${out})`;
}

/** Map a code point to its WinAnsi byte, or 0x3F ("?") when not encodable. */
function winAnsiByte(cp: number): number {
  if (cp < 0x20) return 0x3f;
  if (cp < 0xa0) return cp; // US-ASCII
  if (cp >= 0xa0 && cp <= 0xff) return cp; // Latin-1 block
  const winAnsi: Record<number, number> = {
    0x20ac: 0x80, // euro
    0x201a: 0x82,
    0x0192: 0x83,
    0x201e: 0x84,
    0x2026: 0x85,
    0x2020: 0x86,
    0x2021: 0x87,
    0x02c6: 0x88,
    0x2030: 0x89,
    0x0160: 0x8a,
    0x2039: 0x8b,
    0x0152: 0x8c,
    0x017d: 0x8e,
    0x2018: 0x91,
    0x2019: 0x92,
    0x201c: 0x93,
    0x201d: 0x94,
    0x2022: 0x95,
    0x2013: 0x96,
    0x2014: 0x97,
    0x02dc: 0x98,
    0x2122: 0x99,
    0x0161: 0x9a,
    0x203a: 0x9b,
    0x0153: 0x9c,
    0x017e: 0x9e,
    0x0178: 0x9f,
  };
  return winAnsi[cp] ?? 0x3f;
}

/** Assemble numbered objects into a valid PDF 1.4 with an xref table. */
function assemblePdf(objects: Array<{ num: number; body: string }>): Buffer {
  const sorted = [...objects].sort((a, b) => a.num - b.num);
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (const obj of sorted) {
    offsets[obj.num] = Buffer.byteLength(out, "latin1");
    out += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(out, "latin1");
  const size = sorted.length + 1;
  out += `xref\n0 ${size}\n`;
  out += "0000000000 65535 f \n";
  for (let i = 1; i < size; i++) {
    out += `${(offsets[i] as number).toString().padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const bytes: number[] = [];
  for (const ch of out) bytes.push(ch.codePointAt(0) as number);
  return Buffer.from(bytes);
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
