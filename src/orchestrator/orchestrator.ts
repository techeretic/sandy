import { createHash } from "node:crypto";
import type { McpClientManager } from "../mcp/manager.js";
import { McpCallError } from "../mcp/types.js";
import type { AuditLogger } from "../audit/logger.js";
import { captureTranscript, type Transcript } from "../audit/transcript.js";
import { renderMarkdownReport } from "./report.js";
import type { WriteApprovalGate } from "./write-gate.js";

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
  | { type: "done"; claims: number; gaps: number };

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
  /** Renders a report from claims/gaps. Injectable for tests. */
  renderReport?: (input: RenderReportInput) => string;
  /** Writes the rendered report to disk (confined by the File Manager). Returns the path. */
  writeReport?: (content: string, file: string) => Promise<string>;
  /**
   * Design seam for write-back (Q6). v1 never routes a write task; a future
   * write path must pass this gate before reaching a server. Present on the
   * orchestrator so the contract is fixed now.
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
 * Markdown report where every statement is traceable to its source call.
 */
export class Orchestrator {
  private readonly manager: McpClientManager;
  private readonly audit: AuditLogger;
  private readonly concurrency: number;
  private readonly onProgress: (event: ProgressEvent) => void;
  private readonly renderReport: (input: RenderReportInput) => string;
  private readonly writeReport: ((content: string, file: string) => Promise<string>) | null;

  constructor(options: OrchestratorOptions) {
    this.manager = options.manager;
    this.audit = options.audit;
    this.concurrency = Math.max(1, options.concurrency ?? 5);
    this.onProgress = options.onProgress ?? (() => {});
    this.renderReport = options.renderReport ?? renderMarkdownReport;
    this.writeReport = options.writeReport ?? null;
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
      const file = request.report.file ?? `report-${Date.now()}.md`;
      this.onProgress({ type: "report-writing", path: file });
      if (this.writeReport) {
        reportPath = await this.writeReport(reportContent, file);
      }
    }

    this.onProgress({ type: "done", claims: claims.length, gaps: gaps.length });
    this.audit.append("session_end", { claims: claims.length, gaps: gaps.length, report: reportPath ?? null });

    return { goal: request.goal, claims, gaps, reportPath, reportContent, transcript: captureTranscript(this.audit) };
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
