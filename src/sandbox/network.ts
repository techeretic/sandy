export type EndpointMatch =
  | { ok: true }
  | { ok: false; reason: "not-a-url" | "disallowed-scheme" | "endpoint-not-declared" };

function endpointOf(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
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
  private readonly allowed: ReadonlySet<string>;

  constructor(allowedEndpoints: readonly string[]) {
    this.allowed = new Set(allowedEndpoints.map((e) => e.toLowerCase()));
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
    const endpoint = endpointOf(url).toLowerCase();
    if (!this.allowed.has(endpoint)) {
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
