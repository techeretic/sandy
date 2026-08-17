import type { McpServer } from "../config/schema.js";
import type { SecretResolver } from "../config/loader.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Explicit server health (MCP-09). Failures are never silent. */
export type ServerHealth = "disconnected" | "connected" | "degraded" | "unreachable";

export interface HealthState {
  state: ServerHealth;
  /** Why we are (not) healthy — always human-readable. */
  detail: string;
  /** ISO timestamp of the last health transition. */
  at: string;
}

export interface McpCallRecord {
  server: string;
  tool: string;
  /** sha256 of the canonicalized arguments — args themselves are never logged (AU-02). */
  argsHash: string;
  at: string;
  durationMs: number;
  outcome: "ok" | "error";
  /** Present when outcome is "error". */
  error?: string;
}

/** Audit sink for MCP calls (AU-01/MCP-12). Implemented by the Audit Logger. */
export interface McpAuditSink {
  record(entry: McpCallRecord): void;
}

export class NullAuditSink implements McpAuditSink {
  record(): void {}
}

export type McpCallFailureReason =
  | "tool-not-allowed"
  | "server-unhealthy"
  | "server-unreachable"
  | "transport"
  | "timeout"
  | "protocol";

export class McpCallError extends Error {
  readonly server: string;
  readonly tool: string;
  readonly reason: McpCallFailureReason;
  /** A transport/timeout failure could have been retried; protocol errors are not. */
  readonly retryable: boolean;

  constructor(server: string, tool: string, reason: McpCallFailureReason, message: string, retryable: boolean) {
    super(message);
    this.name = "McpCallError";
    this.server = server;
    this.tool = tool;
    this.reason = reason;
    this.retryable = retryable;
  }
}

export interface RetryPolicy {
  /** Number of retries after the first attempt. Default 2. */
  maxRetries: number;
  /** Base delay in ms. Default 250. */
  baseDelayMs: number;
  /** Multiplier per attempt. Default 2. */
  factor: number;
  /** Cap for any single delay. Default 5000. */
  maxDelayMs: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface McpClientOptions {
  retry?: Partial<RetryPolicy>;
  /** Per-request timeout. Default 30000 ms. */
  requestTimeoutMs?: number;
  /** Audit sink. Default: discard. */
  audit?: McpAuditSink;
  /** Injectable for tests: build a transport without touching the network. */
  transportFactory?: TransportFactory;
}

/** A transport factory: (server config) => transport. Injectable for in-memory tests. */
export type TransportFactory = (server: McpServer, resolver: SecretResolver) => import("@modelcontextprotocol/sdk/shared/transport.js").Transport;

/** Fetch signature matching the MCP SDK (SSE/streamable-HTTP transports). */
export type { FetchLike };
