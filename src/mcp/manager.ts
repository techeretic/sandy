import type { McpServer } from "../config/schema.js";
import type { SecretResolver } from "../config/loader.js";
import {
  ManagedServer,
  type ManagedServerOptions,
} from "./managed-server.js";
import { resolveRetryPolicy } from "./retry.js";
import { NullAuditSink, type HealthState, type McpAuditSink, type McpClientOptions, type RetryPolicy, type TransportFactory } from "./types.js";
import type { NetworkGuard } from "../sandbox/network.js";

export interface ConnectResult {
  /** Servers that connected (health: connected or degraded). */
  ok: string[];
  /** Servers that failed to connect — terminal for this session (MCP-10). */
  failed: Array<{ server: string; error: string }>;
}

export interface HealthSummary {
  connected: string[];
  degraded: Array<{ server: string; detail: string }>;
  unreachable: Array<{ server: string; detail: string }>;
}

/**
 * Owns every MCP server connection for the session (MCP-04).
 *
 * Startup contract (MCP-03): `connectAll()` validates each configured server.
 * A failure is terminal for that data source — it is reported explicitly and
 * the server is NOT left in a half-open state that the model could work
 * around (MCP-10). Remaining servers still connect; a partial fleet is a
 * degraded fleet, and that is said out loud.
 */
export class McpClientManager {
  private readonly servers = new Map<string, ManagedServer>();
  private readonly failed = new Map<string, string>();
  private readonly baseOptions: ManagedServerOptions;
  private readonly resolver: SecretResolver;
  private readonly guard: NetworkGuard;
  private readonly transportFactory: TransportFactory | undefined;

  constructor(
    servers: readonly McpServer[],
    resolver: SecretResolver,
    guard: NetworkGuard,
    options: McpClientOptions = {},
  ) {
    this.resolver = resolver;
    this.guard = guard;
    this.baseOptions = {
      resolver,
      guard,
      retry: resolveRetryPolicy(options.retry),
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      audit: options.audit ?? new NullAuditSink(),
    };
    this.transportFactory = options.transportFactory;
    for (const server of servers) {
      this.servers.set(server.name, this.buildManaged(server));
    }
  }

  private buildManaged(server: McpServer): ManagedServer {
    const opts: ManagedServerOptions = { ...this.baseOptions };
    if (this.transportFactory) opts.transportFactory = this.transportFactory;
    return new ManagedServer(server, opts);
  }

  /** Connect every configured server in parallel (MCP-03/04). */
  async connectAll(): Promise<ConnectResult> {
    const entries = [...this.servers.entries()];
    const results = await Promise.allSettled(
      entries.map(([, server]) => server.connect()),
    );

    const ok: string[] = [];
    const failed: ConnectResult["failed"] = [];
    for (let i = 0; i < entries.length; i++) {
      const [name] = entries[i] as [string, ManagedServer];
      const result = results[i] as PromiseSettledResult<void>;
      if (result.status === "fulfilled") {
        ok.push(name);
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.failed.set(name, message);
        failed.push({ server: name, error: message });
      }
    }

    // Servers that failed to connect are dropped from the callable set: a
    // terminal failure is surfaced, never worked around (MCP-10).
    for (const f of failed) {
      this.servers.delete(f.server);
    }

    return { ok, failed };
  }

  /** Servers successfully connected and callable. */
  get connectedNames(): readonly string[] {
    return [...this.servers.keys()];
  }

  /**
   * Servers that failed at startup (MCP-10). Callers must surface these as
   * explicit gaps in any report (RG-05) — never smooth them over.
   */
  get failedServers(): Array<{ server: string; error: string }> {
    return [...this.failed.entries()].map(([server, error]) => ({ server, error }));
  }

  getServer(name: string): ManagedServer {
    const server = this.servers.get(name);
    if (!server) {
      throw new Error(
        this.failed.has(name)
          ? `MCP server "${name}" failed to connect at startup and is unavailable for this session: ${this.failed.get(name)}`
          : `unknown MCP server "${name}"`,
      );
    }
    return server;
  }

  /** Fan out one tool call across several servers (RG-01 support). */
  async callTool(name: string, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.getServer(name).callTool(tool, args);
  }

  /**
   * Explicit health for every server (MCP-09). Degraded and unreachable are
   * first-class states with a human-readable detail.
   */
  health(): HealthSummary {
    const summary: HealthSummary = { connected: [], degraded: [], unreachable: [] };
    for (const [name, server] of this.servers) {
      const health: HealthState = server.getHealth();
      switch (health.state) {
        case "connected":
          summary.connected.push(name);
          break;
        case "degraded":
          summary.degraded.push({ server: name, detail: health.detail });
          break;
        case "unreachable":
          summary.unreachable.push({ server: name, detail: health.detail });
          break;
        default:
          break;
      }
    }
    return summary;
  }

  /** Close every connection. Idempotent. */
  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((s) => s.close()));
    this.servers.clear();
  }
}
