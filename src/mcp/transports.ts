import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServer } from "../config/schema.js";
import type { SecretResolver } from "../config/loader.js";
import type { AuditLogger } from "../audit/logger.js";
import { NetworkEgressError, type NetworkGuard } from "../sandbox/network.js";

/**
 * Wrap any fetch implementation so that every request is checked against the
 * egress allowlist (SB-07, VPN-02). This is the only path by which the MCP
 * client can touch the network. When an `audit` logger is supplied, a refused
 * dial is recorded as an `egress_blocked` event (AU-01) — a block is a fact
 * that should be in the audit trail, not a silent throw.
 */
export function guardedFetch(
  guard: NetworkGuard,
  inner: FetchLike = globalThis.fetch as FetchLike,
  audit?: AuditLogger,
): FetchLike {
  return async (url: string | URL, init?: RequestInit) => {
    const target = typeof url === "string" ? url : url.toString();
    try {
      guard.assert(target);
    } catch (err) {
      if (err instanceof NetworkEgressError && audit) {
        audit.append("egress_blocked", { target, reason: err.reason });
      }
      throw err;
    }
    return inner(url, init);
  };
}

function authHeaders(server: McpServer, resolver: SecretResolver): Record<string, string> | undefined {
  if (server.transport !== "sse" && server.transport !== "http") return undefined;
  const auth = server.auth;
  if (!auth) return undefined;
  if (auth.type === "bearer") {
    const token = auth.token ? resolver.resolve(auth.token) : undefined;
    if (token === undefined) return undefined;
    return { Authorization: `Bearer ${token}` };
  }
  if (auth.type === "api_key") {
    const token = auth.token ? resolver.resolve(auth.token) : undefined;
    if (token === undefined) return undefined;
    return { Authorization: `Bearer ${token}` };
  }
  // oauth/mtls require the transport's own authProvider/mTLS-cert machinery,
  // which is not wired up yet (a Phase 1 follow-up). Fail closed rather than
  // silently connecting unauthenticated to a server the config says needs
  // oauth/mtls — a config that validates must not produce a weaker runtime
  // guarantee than it declares (MCP-10; GHSA-38wj-6mjh-2jf9).
  throw new Error(
    `MCP server "${server.name}": auth.type "${auth.type}" is not yet implemented ` +
      `(oauth/mtls require the transport's own authProvider/certificate machinery). ` +
      `Refusing to connect unauthenticated. Use "bearer" or "api_key" auth today, or omit auth.`,
  );
}

/**
 * Build the transport for a configured server (MCP-02/05).
 *
 * Secrets are resolved from the SecretResolver at construction time and never
 * stored; network transports route all fetch traffic through the NetworkGuard.
 */
export function createTransport(
  server: McpServer,
  resolver: SecretResolver,
  guard: NetworkGuard,
  fetchImpl: FetchLike = globalThis.fetch as FetchLike,
): Transport {
  if (server.transport === "stdio") {
    const [command, ...args] = server.command;
    const env: Record<string, string> = {};
    for (const [key, ref] of Object.entries(server.env ?? {})) {
      env[key] = resolver.resolve(ref);
    }
    return new StdioClientTransport({
      command: command as string,
      args,
      env,
      stderr: "pipe",
    });
  }

  const headers = authHeaders(server, resolver);
  const fetchWithGuard = guardedFetch(guard, fetchImpl);

  if (server.transport === "sse") {
    return new SSEClientTransport(new URL(server.url), {
      fetch: fetchWithGuard,
      requestInit: headers ? { headers } : undefined,
    });
  }

  // "http"
  return new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: fetchWithGuard,
    requestInit: headers ? { headers } : undefined,
  });
}

export type { NetworkEgressError };
