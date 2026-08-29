/**
 * Supported file formats (FM-08).
 *
 * Sandy supports plain text, CSV, JSON, and Markdown, plus the binary report
 * formats DOCX/XLSX/PDF (issue #14): their content is validated by magic
 * bytes, not text semantics, so the File Manager stores them byte-exact.
 * Format is detected from the file extension; content validation is
 * format-aware (e.g. a `.json` file must parse as JSON on write).
 */

export const SUPPORTED_FORMATS = ["text", "csv", "json", "markdown", "docx", "xlsx", "pdf"] as const;
export type FileFormat = (typeof SUPPORTED_FORMATS)[number];

const EXTENSION_TO_FORMAT: Record<string, FileFormat> = {
  ".txt": "text",
  ".log": "text",
  ".md": "markdown",
  ".markdown": "markdown",
  ".csv": "csv",
  ".json": "json",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pdf": "pdf",
};

/** Detect the format from a filename/extension. Defaults to plain text. */
export function detectFormat(filename: string): FileFormat {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return EXTENSION_TO_FORMAT[ext] ?? "text";
}

/**
 * The binary report formats (issue #14). Their content is an opaque byte
 * stream validated by magic prefix, so it must round-trip byte-exactly
 * (written and journaled as raw bytes, never a UTF-8 string).
 */
export const BINARY_FORMATS = ["docx", "xlsx", "pdf"] as const;
export type BinaryFormat = (typeof BINARY_FORMATS)[number];

/** Is this format a binary artifact (written via {@link FileManager.writeBinary})? */
export function isBinaryFormat(format: FileFormat): format is BinaryFormat {
  return format === "docx" || format === "xlsx" || format === "pdf";
}

/**
 * Validate binary content by its magic prefix. The File Manager is the last
 * confined write path: storing a file under a binary report name whose bytes
 * are not that format would produce a corrupt artifact, so it is refused
 * fail-closed. (DOCX and XLSX are ZIP containers and share the PK magic.)
 */
export function validateBinaryContent(format: BinaryFormat, content: Buffer): string | null {
  const isZip = content.length >= 2 && content[0] === 0x50 && content[1] === 0x4b;
  const isPdf = content.length >= 5 && content.subarray(0, 5).toString("latin1") === "%PDF-";
  switch (format) {
    case "docx":
    case "xlsx":
      return isZip ? null : `not a valid ${format} file (expected the ZIP container magic "PK")`;
    case "pdf":
      return isPdf ? null : `not a valid pdf file (expected the "%PDF-" magic)`;
  }
}

/**
 * Validate that content is well-formed for the given format before it is
 * written. Returns an error string, or null if valid.
 */
export function validateContent(format: FileFormat, content: string): string | null {
  switch (format) {
    case "json": {
      try {
        JSON.parse(content);
        return null;
      } catch (err) {
        return `not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "csv": {
      if (content.length === 0) return null;
      const lineCounts = content
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => countCsvFields(line));
      const first = lineCounts[0];
      if (first === undefined) return null;
      for (const count of lineCounts) {
        if (count !== first) {
          return `inconsistent CSV: first row has ${first} field(s), a later row has ${count}`;
        }
      }
      return null;
    }
    case "text":
    case "markdown":
      return null;
    case "docx":
    case "xlsx":
    case "pdf":
      // A text write to a binary report name would produce a corrupt
      // artifact (a UTF-8 string where a container is expected): refuse
      // fail-closed; byte-exact content goes through writeBinary.
      return `${format} is a binary format; use writeBinary with the rendered bytes`;
  }
}

function countCsvFields(line: string): number {
  let fields = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) fields++;
  }
  return fields;
}
