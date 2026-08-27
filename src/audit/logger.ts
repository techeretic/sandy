import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { McpCallRecord, McpAuditSink } from "../mcp/types.js";
import type { FileAuditSink } from "../files/file-manager.js";

/**
 * The structured, append-only audit log (AU-01).
 *
 * Every operation of consequence is recorded here: MCP calls, filesystem
 * mutations, model invocations, and session lifecycle. The log is append-only
 * — entries are never rewritten or truncated for the life of a session.
 */

export type AuditEventType =
  | "mcp_call"
  | "file_mutation"
  | "model_invocation"
  | "orchestrator_task"
  | "write_attempt"
  | "sandbox_violation"
  | "egress_blocked"
  | "session_start"
  | "session_end"
  // Autonomous loop (Phase 2): the bundled model's parse/narrate steps. The
  // model invocations themselves are `model_invocation` events (AU-01); these
  // record the loop's own decisions (outcome, plan source, narrative).
  | "standalone_parse"
  | "standalone_plan"
  | "standalone_narrate"
  // Multi-round planning (issue #19): the loop's replan decisions.
  | "standalone_replan"
  // Recurring templates (issue #15): a run job resolved from a saved request.
  | "template_run";

export interface AuditEvent {
  /** Monotonic sequence number within the session (1-based). */
  seq: number;
  /** ISO-8601 timestamp. */
  at: string;
  type: AuditEventType;
  /** Type-specific, structured data. */
  data: Record<string, unknown>;
  /**
   * Raw payload (retrieved data, model prompt/completion). Present ONLY when
   * payload logging is opted in (AU-02). Absent by default.
   */
  payload?: unknown;
}

export interface AuditLogger {
  /**
   * Append an event. Returns the stored event (with its sequence number).
   * This is synchronous with respect to ordering: a later append is always a
   * higher seq. Disk persistence, where present, is async but ordered.
   */
  append(type: AuditEventType, data: Record<string, unknown>, opts?: { payload?: unknown }): AuditEvent;
  /** All events appended this session, in order. */
  events(): readonly AuditEvent[];
  /** Flush and release resources. */
  close(): Promise<void>;
}

/**
 * In-memory, session-scoped audit logger (AU-01). The reference
 * implementation; also used in tests.
 */
export class InMemoryAuditLogger implements AuditLogger {
  private readonly entries: AuditEvent[] = [];
  private seq = 0;
  private readonly payloadLogging: boolean;

  constructor(options: { auditPayloadLogging?: boolean } = {}) {
    this.payloadLogging = options.auditPayloadLogging ?? false;
  }

  append(type: AuditEventType, data: Record<string, unknown>, opts?: { payload?: unknown }): AuditEvent {
    const event: AuditEvent = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      type,
      data,
    };
    // AU-02: payload is opt-in and centralized here so no caller can leak it
    // past policy.
    if (this.payloadLogging && opts?.payload !== undefined) {
      event.payload = opts.payload;
    }
    this.entries.push(event);
    return event;
  }

  events(): readonly AuditEvent[] {
    return this.entries;
  }

  async close(): Promise<void> {}
}

/**
 * Append-only JSONL audit logger (AU-01). Writes one JSON object per line to
 * a file, in order. Keeps an in-memory mirror for the session so transcript
 * export works (AU-03).
 */
export class JsonlAuditLogger implements AuditLogger {
  private readonly memory: InMemoryAuditLogger;
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  private writeError: Error | undefined;

  constructor(filePath: string, options: { auditPayloadLogging?: boolean } = {}) {
    this.filePath = filePath;
    this.memory = new InMemoryAuditLogger(options);
  }

  get path(): string {
    return this.filePath;
  }

  append(type: AuditEventType, data: Record<string, unknown>, opts?: { payload?: unknown }): AuditEvent {
    const event = this.memory.append(type, data, opts);
    if (!this.closed) {
      const line = `${JSON.stringify(event)}\n`;
      this.writeChain = this.writeChain
        .then(async () => {
          await mkdir(path.dirname(this.filePath), { recursive: true });
          await appendFile(this.filePath, line, "utf8");
        })
        .catch((err) => {
          // The audit log is supposed to be a complete, reliable record — a
          // write failure must never vanish silently (it used to become an
          // unhandled promise rejection with no operator-visible signal).
          // Surface it loudly now (stderr) and remember the first failure so
          // close() reports it to the caller, instead of swallowing it.
          const wrapped = err instanceof Error ? err : new Error(String(err));
          this.writeError ??= wrapped;
          process.stderr.write(
            `sandy: audit log write to ${this.filePath} failed: ${wrapped.message}\n`,
          );
        });
    }
    return event;
  }

  events(): readonly AuditEvent[] {
    return this.memory.events();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain;
    if (this.writeError) throw this.writeError;
  }
}

// --- Bridges: existing component sinks → unified audit log ------------------

/** Adapt the MCP call-sink interface to an AuditLogger (AU-01/MCP-12). */
export function mcpAuditSink(logger: AuditLogger): McpAuditSink {
  return {
    record(entry: McpCallRecord): void {
      logger.append("mcp_call", {
        server: entry.server,
        tool: entry.tool,
        argsHash: entry.argsHash,
        durationMs: entry.durationMs,
        outcome: entry.outcome,
        error: entry.error,
      });
    },
  };
}

/** Adapt the file-mutation sink interface to an AuditLogger (AU-01). */
export function fileAuditSink(logger: AuditLogger): FileAuditSink {
  return {
    record(entry: { op: string; path: string; at: string; outcome: "ok" | "error"; error?: string; dryRun?: boolean }): void {
      logger.append("file_mutation", {
        op: entry.op,
        path: entry.path,
        outcome: entry.outcome,
        error: entry.error,
        dryRun: entry.dryRun,
      });
    },
  };
}

/** Record a model invocation with token counts (AU-01). */
export function logModelInvocation(
  logger: AuditLogger,
  details: {
    provider: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
    outcome?: "ok" | "error";
    error?: string;
  },
  opts?: { payload?: unknown },
): AuditEvent {
  return logger.append("model_invocation", { ...details }, opts);
}
