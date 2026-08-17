/**
 * Supported file formats (FM-08).
 *
 * Sandy supports plain text, CSV, JSON, and Markdown. These are the formats
 * the File Manager will read, write, and validate. Format is detected from
 * the file extension; content validation is format-aware (e.g. a `.json`
 * file must parse as JSON on write).
 */

export const SUPPORTED_FORMATS = ["text", "csv", "json", "markdown"] as const;
export type FileFormat = (typeof SUPPORTED_FORMATS)[number];

const EXTENSION_TO_FORMAT: Record<string, FileFormat> = {
  ".txt": "text",
  ".log": "text",
  ".md": "markdown",
  ".markdown": "markdown",
  ".csv": "csv",
  ".json": "json",
};

/** Detect the format from a filename/extension. Defaults to plain text. */
export function detectFormat(filename: string): FileFormat {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return EXTENSION_TO_FORMAT[ext] ?? "text";
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
    default:
      return null;
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
