export type EndpointMatch =
  | { ok: true }
  | { ok: false; reason: "not-a-url" | "disallowed-scheme" | "endpoint-not-declared" };

/**
 * Does an allowlist entry ("host" or "host:port") match this URL?
 *
 * WHATWG's URL parser normalizes away the port when it equals the scheme's
 * default (443 for https, 80 for http) even when written explicitly
 * (`new URL("https://host:443").port === ""`), so the port must never be
 * trusted as-is — it is reconstructed from the scheme when absent. An entry
 * written with the scheme's default port (the schema's documented form, and
 * the form used by the shipped config/sandy.json) therefore matches a
 * default-port URL, an entry without a port matches the default port for
 * the URL's scheme, and a non-default entry like "host:8443" still matches
 * only :8443 URLs.
 */
export function endpointMatches(entry: string, url: URL): boolean {
  const idx = entry.lastIndexOf(":");
  const host = idx > 0 ? entry.slice(0, idx) : entry;
  if (host.toLowerCase() !== url.hostname) return false;
  // A bare-host entry (no ":port") authorizes only the scheme's default port,
  // which is exactly the case where the URL parser leaves `url.port` empty.
  if (idx <= 0) return url.port === "";
  const entryPort = entry.slice(idx + 1);
  if (!/^\d{1,5}$/.test(entryPort)) return false;
  // Reconstruct the scheme's default port, which the parser strips, so an
  // entry written as "host:443" matches a default-port https URL.
  const urlPort = url.port || (url.protocol === "https:" ? "443" : "80");
  return entryPort === urlPort;
}

/**
 * The only gate through which the MCP client may open a network connection
 * (SB-07, VPN-01, VPN-02).
 *
 * Sandy carries no general HTTP client; this guard is what the transport
 * layer calls before any dial. It is deliberately tiny and pure so its
 * behavior is trivially auditable.
 */
export class NetworkGuard {
  private readonly allowed: readonly string[];

  constructor(allowedEndpoints: readonly string[]) {
    this.allowed = allowedEndpoints.map((e) => e.toLowerCase());
  }

  get declared(): readonly string[] {
    return [...this.allowed];
  }

  /**
   * Check a target URL against the declared egress allowlist.
   * Only http(s) are permitted; everything else is refused.
   */
  check(target: string): EndpointMatch {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return { ok: false, reason: "not-a-url" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, reason: "disallowed-scheme" };
    }
    if (!this.allowed.some((e) => endpointMatches(e, url))) {
      return { ok: false, reason: "endpoint-not-declared" };
    }
    return { ok: true };
  }

  /** Returns true if the target is permitted; throws otherwise. */
  assert(target: string): void {
    const verdict = this.check(target);
    if (!verdict.ok) {
      throw new NetworkEgressError(target, verdict.reason);
    }
  }
}

export class NetworkEgressError extends Error {
  readonly target: string;
  readonly reason: Exclude<EndpointMatch, { ok: true }>["reason"];

  constructor(target: string, reason: Exclude<EndpointMatch, { ok: true }>["reason"]) {
    super(`egress blocked (${reason}): ${target} is not in the declared allowlist`);
    this.name = "NetworkEgressError";
    this.target = target;
    this.reason = reason;
  }
}
