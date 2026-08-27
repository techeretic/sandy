import { createHash } from "node:crypto";
import type { McpClientManager } from "../mcp/manager.js";
import { McpCallError } from "../mcp/types.js";
import type { AuditLogger } from "../audit/logger.js";
import { captureTranscript, type Transcript } from "../audit/transcript.js";
import { renderMarkdownReport, renderReport, reportFormatExtension, type ReportFormat } from "./report.js";
import {
  logWriteAttempt,
  ReadOnlyGate,
  type WriteApproval,
  type WriteApprovalGate,
  type WriteTask,
} from "./write-gate.js";

/**
 * A single retrieval unit: one tool call on one MCP server.
 */
export interface GatherTask {
  /** Stable id used in provenance references. */
  id: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  /** Human-readable label for progress and the report. */
  description?: string;
}

/** Streaming progress events (Q4). Emitted as work happens. */
export type ProgressEvent =
  | { type: "task-started"; task: string; server: string; tool: string }
  | { type: "task-succeeded"; task: string; durationMs: number }
  | { type: "task-failed"; task: string; error: string }
  | { type: "report-writing"; path: string }
  // Write-back (Q6): a write task passing the approval gate.
  | { type: "write-approved"; task: string; server: string; tool: string; approver: string }
  | { type: "write-denied"; task: string; reason: string }
  | { type: "write-succeeded"; task: string; durationMs: number }
  | { type: "write-failed"; task: string; error: string }
  | { type: "done"; claims: number; gaps: number }
  // Autonomous-loop (Phase 2) stages — the host LLM's planning/narrating, done
  // by the bundled model instead.
  | { type: "parse-started"; maxAttempts: number }
  | { type: "parse-attempt-failed"; attempt: number; error: string }
  | { type: "parse-fallback"; reason: string }
  // Multi-round planning (issue #19): the loop re-plans from the previous
  // round's results — either adding a further gather pass or stopping.
  | { type: "replan-started"; round: number; maxRounds: number }
  | { type: "replan-attempt-failed"; round: number; attempt: number; error: string }
  | { type: "replan-stopped"; round: number; reason: "stop" | "nothing-new" | "exhausted" | "max-rounds" }
  | { type: "narrating" };

/** A provenance-tracked statement produced by the run (RG-04). */
export interface Claim {
  /** 1-based footnote number. */
  ref: number;
  text: string;
  source: {
    task: string;
    server: string;
    tool: string;
    /** sha256 of the canonicalized args that produced this claim. */
    argsHash: string;
    at: string;
  };
}

/** An explicit hole in the data (RG-05/06). Never smoothed over. */
export interface Gap {
  task: string;
  server: string;
  tool: string;
  reason: "server-unavailable" | "call-failed" | "empty-result";
  detail: string;
}

/**
 * The outcome of one write task (Q6). A refused write is a terminal, audited
 * rejection (contract point 5) — it is reported here, never retried silently,
 * and never turns into a claim or a gap (a write is a distinct task kind from
 * a gather).
 */
export interface WriteResult {
  task: string;
  server: string;
  tool: string;
  allowed: boolean;
  /** Why it was refused (absent when allowed). */
  reason?: "not-allowed-by-policy" | "no-approval" | "gate-refused";
  /** The server's result, when the write was approved and executed. */
  result?: unknown;
  /** The failure, when an approved write could not be executed. */
  error?: string;
}

export interface OrchestratorRequest {
  /** What the user asked for, in their words. */
  goal: string;
  gather: GatherTask[];
  /** Optional report to produce from the gathered claims. */
  report?: {
    title?: string;
    /** Relative to the configured report output dir. */
    file?: string;
    /** Narrative the host LLM supplies; claims remain independently traceable. */
    summary?: string;
  };
}

export interface OrchestratorResult {
  goal: string;
  claims: Claim[];
  gaps: Gap[];
  reportPath?: string;
  reportContent?: string;
  /** Set when report rendering succeeded but writing it to disk failed
   *  (e.g. a format/extension mismatch) -- claims/gaps are still returned. */
  reportError?: string;
  transcript: Transcript;
}

export interface RenderReportInput {
  goal: string;
  title: string;
  claims: Claim[];
  gaps: Gap[];
  generatedAt: string;
  summary?: string;
}

export interface OrchestratorOptions {
  manager: McpClientManager;
  audit: AuditLogger;
  /** Concurrency bound for parallel tool calls. Default 5. */
  concurrency?: number;
  /** Progress sink (Q4). */
  onProgress?: (event: ProgressEvent) => void;
  /**
   * The report format to render (issue #14). Drives the default renderer
   * (`renderReport(format, input)`) and the default report file's extension.
   * Default "markdown". Overridden by an explicit `renderReport` when that is
   * supplied (tests / custom renderers).
   */
  reportFormat?: ReportFormat;
  /** Renders a report from claims/gaps. Injectable for tests. */
  renderReport?: (input: RenderReportInput) => string;
  /** Writes the rendered report to disk (confined by the File Manager). Returns the path. */
  writeReport?: (content: string, file: string) => Promise<string>;
  /**
   * The gate every write task must pass before reaching a server (Q6).
   * Defaults to {@link ReadOnlyGate} — refuse all writes — so a deployment
   * that has not opted into write-back can never write.
   */
  writeGate?: WriteApprovalGate;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function hashOf(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(args)).digest("hex");
}

/**
 * The identity of a tool call for de-duplication (issue #19): the same server,
 * tool, and (canonicalized) args — the same canonical form as `hashOf`. The
 * multi-round loop uses it to refuse re-gathering what an earlier round already
 * gathered (a replan that only re-proposes known calls is "nothing new").
 */
export function callSignature(server: string, tool: string, args: Record<string, unknown>): string {
  return `${server}/${tool} ${canonicalize(args)}`;
}

/**
 * Extracts text claims from an MCP tool result. The manager returns the
 * unwrapped content array; a full `{ content }` wrapper is also accepted for
 * robustness. One non-empty text block becomes one claim. A result with no
 * text is an empty result — a gap, never invented filler (RG-06).
 */
function extractText(result: unknown): string[] {
  const content = Array.isArray(result)
    ? (result as Array<{ type?: string; text?: string }>)
    : (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => (c.text as string).trim())
    .filter((t) => t.length > 0);
}

/**
 * The Orchestrator: coordinates multi-step workflows across MCP servers
 * (PRD 7.1).
 *
 * v1 is read-and-report (RG-*). It fans out gather tasks across servers with
 * bounded concurrency, converts each successful call into provenance-tagged
 * claims, records every failure as an explicit gap, and optionally renders a
 * report (Markdown by default, HTML via `reportFormat`, issue #14) where every
 * statement is traceable to its source call.
 */
export class Orchestrator {
  private readonly manager: McpClientManager;
  private readonly audit: AuditLogger;
  private readonly concurrency: number;
  /** Swappable (see {@link setProgressSink}) so a long-lived host can redirect
   *  per-job progress in-band. */
  private onProgress: (event: ProgressEvent) => void;
  private readonly reportFormat: ReportFormat;
  private readonly renderReport: (input: RenderReportInput) => string;
  private readonly writeReport: ((content: string, file: string) => Promise<string>) | null;
  private readonly writeGate: WriteApprovalGate;

  constructor(options: OrchestratorOptions) {
    this.manager = options.manager;
    this.audit = options.audit;
    this.concurrency = Math.max(1, options.concurrency ?? 5);
    this.onProgress = options.onProgress ?? (() => {});
    this.reportFormat = options.reportFormat ?? "markdown";
    // An explicitly injected renderer wins (tests / custom renderers);
    // otherwise the default renderer is bound to the configured format.
    this.renderReport = options.renderReport ?? ((input) => renderReport(this.reportFormat, input));
    this.writeReport = options.writeReport ?? null;
    // Fail closed: a deployment that has not supplied a gate refuses every
    // write (the v1 read-and-report default, Q6).
    this.writeGate = options.writeGate ?? new ReadOnlyGate();
  }

  /** The current progress sink (Q4). */
  getProgressSink(): (event: ProgressEvent) => void {
    return this.onProgress;
  }

  /**
   * Swap the progress sink. Lets a long-lived host (the service's job worker)
   * redirect per-job progress in-band — the same pattern the plugin uses with
   * its `ProgressCollector` — and restore the previous sink when done.
   */
  setProgressSink(sink: (event: ProgressEvent) => void): void {
    this.onProgress = sink;
  }

  async run(request: OrchestratorRequest): Promise<OrchestratorResult> {
    this.audit.append("session_start", { goal: request.goal, tasks: request.gather.length });

    const claims: Claim[] = [];
    const gaps: Gap[] = [];
    let ref = 0;

    const gapsFromFanOut = await this.fanOut(request.gather, (task, result, meta) => {
      const texts = extractText(result);
      if (texts.length === 0) {
        gaps.push({
          task: task.id,
          server: task.server,
          tool: task.tool,
          reason: "empty-result",
          detail: "the tool returned no usable data",
        });
        return;
      }
      for (const text of texts) {
        claims.push({
          ref: ++ref,
          text,
          source: { task: task.id, server: task.server, tool: task.tool, argsHash: meta.argsHash, at: meta.at },
        });
      }
    });
    gaps.push(...gapsFromFanOut);

    // RG-05: a server that failed at startup must appear as a gap whenever a
    // task targeted it — the report says so, never smooths it over.
    for (const failed of this.manager.failedServers) {
      for (const task of request.gather.filter((t) => t.server === failed.server)) {
        if (!gaps.some((g) => g.task === task.id)) {
          gaps.push({
            task: task.id,
            server: task.server,
            tool: task.tool,
            reason: "server-unavailable",
            detail: `server "${task.server}" was unreachable at startup: ${failed.error}`,
          });
        }
      }
    }

    let reportPath: string | undefined;
    let reportContent: string | undefined;
    let reportError: string | undefined;
    if (request.report) {
      const generatedAt = new Date().toISOString();
      reportContent = this.renderReport({
        goal: request.goal,
        title: request.report.title ?? request.goal,
        claims,
        gaps,
        generatedAt,
        summary: request.report.summary,
      });
      // The default filename's extension follows the report format (issue
      // #14); an explicit `file` in the request is honored as-is.
      const file = request.report.file ?? `report-${Date.now()}${reportFormatExtension(this.reportFormat)}`;
      this.onProgress({ type: "report-writing", path: file });
      if (this.writeReport) {
        try {
          reportPath = await this.writeReport(reportContent, file);
        } catch (err) {
          // A filename/format choice must not discard the data already
          // gathered from (potentially many) successful MCP calls: surface the
          // failure on the result and in the audit trail, and keep going.
          reportError = err instanceof Error ? err.message : String(err);
          this.audit.append("orchestrator_task", {
            task: "report-write",
            server: "sandy",
            tool: "write-report",
            outcome: "error",
            error: reportError,
          });
        }
      }
    }

    this.onProgress({ type: "done", claims: claims.length, gaps: gaps.length });
    this.audit.append("session_end", { claims: claims.length, gaps: gaps.length, report: reportPath ?? null, reportError: reportError ?? null });

    return { goal: request.goal, claims, gaps, reportPath, reportContent, reportError, transcript: captureTranscript(this.audit) };
  }

  /**
   * Execute write tasks (Q6). Each task must pass the {@link WriteApprovalGate}
   * before it reaches a server; the decision is audited for every task
   * regardless of outcome (AU-01). A refused write is terminal — reported in
   * the result, never retried, and never converted into a claim or a gap.
   */
  async write(tasks: WriteTask[], approvals?: Record<string, WriteApproval>): Promise<WriteResult[]> {
    const results: WriteResult[] = [];
    for (const task of tasks) {
      const approval = approvals?.[task.id];
      const decision = await this.writeGate.decide(task, approval);
      logWriteAttempt(this.audit, task, decision);
      if (!decision.allowed) {
        this.onProgress({ type: "write-denied", task: task.id, reason: decision.reason });
        results.push({
          task: task.id,
          server: task.server,
          tool: task.tool,
          allowed: false,
          reason: decision.reason,
        });
        continue;
      }
      this.onProgress({
        type: "write-approved",
        task: task.id,
        server: task.server,
        tool: task.tool,
        approver: decision.approval.approver,
      });
      const started = Date.now();
      const argsHash = hashOf(task.args);
      try {
        const result = await this.manager.callTool(task.server, task.tool, task.args);
        this.audit.append("orchestrator_task", {
          task: task.id,
          server: task.server,
          tool: task.tool,
          argsHash,
          kind: "write",
          outcome: "ok",
          durationMs: Date.now() - started,
        });
        this.onProgress({ type: "write-succeeded", task: task.id, durationMs: Date.now() - started });
        results.push({
          task: task.id,
          server: task.server,
          tool: task.tool,
          allowed: true,
          result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.audit.append("orchestrator_task", {
          task: task.id,
          server: task.server,
          tool: task.tool,
          argsHash,
          kind: "write",
          outcome: "error",
          error: message,
        });
        this.onProgress({ type: "write-failed", task: task.id, error: message });
        results.push({
          task: task.id,
          server: task.server,
          tool: task.tool,
          allowed: true,
          error: message,
        });
      }
    }
    return results;
  }

  /**
   * Run gather tasks with bounded concurrency (RG-01). Each task is exactly
   * one MCP tool call. Returns the gaps encountered (failures); successes are
   * routed to `onResult`.
   */
  private async fanOut(
    tasks: GatherTask[],
    onResult: (task: GatherTask, result: unknown, meta: { argsHash: string; at: string }) => void,
  ): Promise<Gap[]> {
    const gaps: Gap[] = [];
    const queue = [...tasks];
    const workerCount = Math.min(this.concurrency, Math.max(1, queue.length));

    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const task = queue.shift();
        if (!task) return;
        this.onProgress({ type: "task-started", task: task.id, server: task.server, tool: task.tool });
        const started = Date.now();
        const at = new Date().toISOString();
        const argsHash = hashOf(task.args);
        try {
          const result = await this.manager.callTool(task.server, task.tool, task.args);
          this.audit.append("orchestrator_task", {
            task: task.id,
            server: task.server,
            tool: task.tool,
            argsHash,
            outcome: "ok",
            durationMs: Date.now() - started,
          });
          this.onProgress({ type: "task-succeeded", task: task.id, durationMs: Date.now() - started });
          onResult(task, result, { argsHash, at });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const reason: Gap["reason"] =
            err instanceof McpCallError && (err.reason === "server-unreachable" || err.reason === "server-unhealthy")
              ? "server-unavailable"
              : "call-failed";
          gaps.push({ task: task.id, server: task.server, tool: task.tool, reason, detail: message });
          this.audit.append("orchestrator_task", {
            task: task.id,
            server: task.server,
            tool: task.tool,
            argsHash,
            outcome: "error",
            error: message,
          });
          this.onProgress({ type: "task-failed", task: task.id, error: message });
        }
      }
    });

    await Promise.all(workers);
    return gaps;
  }
}
