/**
 * Ignore-pattern matching (FM-07).
 *
 * Patterns are gitignore-lite: a bare name ("node_modules", ".git") matches
 * any path segment equal to it; a glob ("*.env", "dist-?") matches segments
 * via a simple `*`/`?` glob. If ANY segment of a path matches a pattern, the
 * path is ignored — which also covers "everything under an ignored dir",
 * since an ancestor segment would already match.
 */

interface CompiledPattern {
  regex: RegExp;
  raw: string;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

export function compilePatterns(patterns: readonly string[]): CompiledPattern[] {
  return patterns
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((raw) => ({ raw, regex: globToRegExp(raw.replace(/\/+$/, "")) }));
}

/** True if any segment of `relPath` matches any pattern. */
export function isIgnored(relPath: string, compiled: CompiledPattern[]): boolean {
  if (compiled.length === 0) return false;
  const normalized = relPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  for (const segment of segments) {
    for (const { regex } of compiled) {
      if (regex.test(segment)) return true;
    }
  }
  // Also allow a pattern that targets the full relative path (e.g. "a/b.txt").
  for (const { regex } of compiled) {
    if (regex.test(normalized)) return true;
  }
  return false;
}

/** Convenience: compile + test in one call. */
export function isIgnoredByPatterns(relPath: string, patterns: readonly string[]): boolean {
  return isIgnored(relPath, compilePatterns(patterns));
}
