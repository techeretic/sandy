/**
 * XML text escaping for the binary report renderers (issue #14).
 *
 * DOCX and XLSX parts are XML: every text node must be escaped, so a claim
 * containing `<this & that>` round-trips as data, never markup.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
