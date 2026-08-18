import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServer } from "../config/schema.js";
import type { SecretResolver } from "../config/loader.js";
import { McpCallError, NullAuditSink, type HealthState, type McpAuditSink, type RetryPolicy } from "./types.js";
import { withRetry } from "./retry.js";
import { createTransport } from "./transports.js";
import type { NetworkGuard } from "../sandbox/network.js";

export interface ManagedServerOptions {
  resolver: SecretResolver;
  guard: NetworkGuard;
  retry: RetryPolicy;
  requestTimeoutMs: number;
  audit: McpAuditSink;
  /** Injectable for tests: build a transport without touching the network. */
  transportFactory?: (server: McpServer, resolver: SecretResolver) => Transport;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function hashArgs(args: unknown): string {
  return createHash("sha256").update(canonicalize(args)).digest("hex");
}

/** Extract a short human-readable message from a failed tool result. */
function toolResultText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return "tool reported an error";
  const texts = content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text);
  return texts.length > 0 ? texts.join(" ") : "tool reported an error";
}

const RETRYABLE_MCP_ERROR_CODES = new Set([
  -32001, // RequestTimeout (MCP extension)
  -32603, // InternalError
]);

function isRetryableError(err: unknown): boolean {
  if (err instanceof McpCallError) return err.retryable;
  // SDK protocol errors (McpError): retry only transient-looking codes,
  // never parse/validation/method errors.
  if (err instanceof Error && err.name === "McpError") {
    const code = (err as { code?: number }).code;
    return typeof code === "number" && RETRYABLE_MCP_ERROR_CODES.has(code);
  }
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|ECONN|ECONNRESET|EAI_AGAIN|socket|fetch failed|network/i.test(message);
}

/**
 * A single connected MCP server under Sandy's management.
 *
 * Enforces, per server:
 *  - the tool allowlist (MCP-07) — a call to a non-allowed tool never reaches
 *    the wire,
 *  - retries with backoff (MCP-11),
 *  - explicit health (MCP-09) — unreachable / degraded are surfaced,
 *  - audit logging of every call (AU-01/MCP-12) — args by hash only.
 */
export class ManagedServer {
  readonly name: string;
  readonly allowedTools: ReadonlySet<string>;

  private readonly server: McpServer;
  private readonly options: ManagedServerOptions;
  private client: Client | null = null;
  private health: HealthState = { state: "disconnected", detail: "not connected", at: new Date().toISOString() };
  private closed = false;

  constructor(server: McpServer, options: ManagedServerOptions) {
    this.name = server.name;
    this.allowedTools = new Set(server.allowed_tools);
    this.server = server;
    this.options = options;
  }

  get isHealthy(): boolean {
    return this.health.state === "connected";
  }

  getHealth(): HealthState {
    return this.health;
  }

  private setHealth(state: HealthState["state"], detail: string): void {
    this.health = { state, detail, at: new Date().toISOString() };
  }

  /**
   * Connect and validate (MCP-03). Throws on failure — the manager treats
   * that as a terminal, explicit state for this server (MCP-10).
   */
  async connect(): Promise<void> {
    if (this.closed) throw new McpCallError(this.name, "*", "server-unhealthy", "server is closed", false);
    const client = new Client({ name: "sandy", version: "0.1.0" });
    const factory =
      this.options.transportFactory ??
      ((s: McpServer, r: SecretResolver) => createTransport(s, r, this.options.guard, globalThis.fetch));
    const transport = factory(this.server, this.options.resolver);

    try {
      await client.connect(transport);
    } catch (err) {
      this.setHealth("unreachable", `connect failed: ${err instanceof Error ? err.message : String(err)}`);
      // A failed connect can leave the transport holding OS handles — a
      // spawned stdio child process, or an in-flight SSE/streamable-HTTP
      // socket. Release it so the process can exit and no child is orphaned
      // (a terminal failure is also a *clean* one, MCP-10).
      try {
        await transport.close();
      } catch {
        // transport may already be torn down
      }
      try {
        await client.close();
      } catch {
        // client never fully connected
      }
      throw err;
    }

    // Validate availability + capabilities (MCP-03) and confirm every
    // allowed tool exists on the server. A missing tool is "degraded", not a
    // silent gap.
    const missing: string[] = [];
    try {
      const { tools } = await client.listTools();
      const available = new Set(tools.map((t) => t.name));
      for (const tool of this.server.allowed_tools) {
        if (!available.has(tool)) missing.push(tool);
      }
    } catch (err) {
      // Some servers do not implement tools/list; we still connected.
      this.setHealth("degraded", `connected but tools/list failed: ${err instanceof Error ? err.message : String(err)}`);
      this.client = client;
      return;
    }

    this.client = client;
    if (missing.length > 0) {
      this.setHealth("degraded", `connected; allowed tool(s) missing on server: ${missing.join(", ")}`);
    } else {
      this.setHealth("connected", `connected; ${this.allowedTools.size} tool(s) available`);
    }
  }

  /**
   * Call a tool. Enforces the allowlist, retries transient failures, and
   * audits the call (args by hash — never the values, AU-02).
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw new McpCallError(this.name, name, "server-unhealthy", "server is closed", false);
    if (!this.client) throw new McpCallError(this.name, name, "server-unreachable", "not connected", false);

    // MCP-07: per-server tool allowlist. Refused before anything hits the wire.
    if (!this.allowedTools.has(name)) {
      throw new McpCallError(this.name, name, "tool-not-allowed", `tool "${name}" is not in the allowlist for server "${this.name}"`, false);
    }

    const client = this.client;
    const record = (outcome: "ok" | "error", durationMs: number, error?: string): void => {
      this.options.audit.record({
        server: this.name,
        tool: name,
        argsHash: hashArgs(args),
        at: new Date().toISOString(),
        durationMs,
        outcome,
        error,
      });
    };

    try {
      const result = await withRetry(
        this.options.retry,
        async () => {
          const started = Date.now();
          try {
            const res = await client.callTool({ name, arguments: args }, undefined, {
              timeout: this.options.requestTimeoutMs,
            });
            // A tool that ran but failed reports isError: true. That is a
            // protocol-level outcome: surfaced explicitly, never retried
            // blindly, and it counts as a call for audit purposes.
            if ((res as { isError?: boolean }).isError) {
              const detail = toolResultText(res);
              record("error", Date.now() - started, detail);
              throw new McpCallError(this.name, name, "protocol", `tool "${this.name}/${name}" reported an error: ${detail}`, false);
            }
            record("ok", Date.now() - started);
            return res;
          } catch (err) {
            if (err instanceof McpCallError) throw err;
            const retryable = isRetryableError(err);
            record("error", Date.now() - started, err instanceof Error ? err.message : String(err));
            throw new McpCallError(
              this.name,
              name,
              /timeout/i.test(err instanceof Error ? err.message : String(err)) ? "timeout" : "transport",
              `call to "${this.name}/${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
              retryable,
            );
          }
        },
        (err) => err instanceof McpCallError && err.retryable,
      );

      if (this.health.state !== "connected") this.setHealth("connected", `recovered; ${this.allowedTools.size} tool(s) available`);
      return (result as { content?: unknown }).content ?? result;
    } catch (err) {
      if (err instanceof McpCallError && err.reason !== "tool-not-allowed") {
        this.setHealth("degraded", `last call to "${name}" failed: ${err.message}`);
      }
      throw err;
    }
  }

  /** Disconnect and release resources. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const client = this.client;
    this.client = null;
    this.setHealth("disconnected", "closed");
    if (client) {
      try {
        await client.close();
      } catch {
        // closing an already-dead transport is not an error worth surfacing
      }
    }
  }
}

export { NullAuditSink };
