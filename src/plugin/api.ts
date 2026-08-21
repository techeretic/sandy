import { z } from "zod";
import {
  ConfirmationRequiredError,
  FileOpError,
  type FileOpOptions,
  type FileMutationResult,
} from "../files/file-manager.js";
import { SandboxViolationError } from "../sandbox/confinement.js";
import type { FilesError } from "./tools.js";
import {
  toOrchestratorRequest,
  type OrchestratorRequestInput,
} from "../orchestrator/request.js";
import type { OrchestratorResult, ProgressEvent } from "../orchestrator/orchestrator.js";
import type { PluginSession } from "./state.js";
import {
  filesDeleteInput,
  filesListInput,
  filesMkdirInput,
  filesReadInput,
  filesRenameInput,
  filesWriteInput,
  gatherToolInput,
  modelUsageInput,
  reportToolInput,
  statusToolInput,
  type FilesListResult,
  type FilesMutateResult,
  type FilesReadResult,
  type GatherToolResult,
  type ModelUsageToolResult,
  type ReportToolResult,
  type StatusToolResult,
} from "./tools.js";

/**
 * A tool body the host supplied that fails validation. Carries field-level
 * issues so the host LLM can correct the call, rather than a generic failure.
 */
export class ToolInputError extends Error {
  constructor(readonly tool: string, readonly issues: Array<{ path: string; message: string }>) {
    super(`${tool}: invalid input — ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "ToolInputError";
  }
}

function validate<S extends z.ZodType>(tool: string, schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.join(".") || "(root)",
      message: i.message,
    }));
    throw new ToolInputError(tool, issues);
  }
  return parsed.data;
}

function opOptions(input: { confirmed?: boolean; dryRun?: boolean }): FileOpOptions {
  const opts: FileOpOptions = {};
  if (input.confirmed !== undefined) opts.confirmed = input.confirmed;
  if (input.dryRun !== undefined) opts.dryRun = input.dryRun;
  return opts;
}

function fileError(err: unknown): FilesError {
  if (err instanceof FileOpError) return { reason: err.reason, detail: err.message };
  if (err instanceof SandboxViolationError) return { reason: "violation", detail: err.message };
  return { reason: "io", detail: err instanceof Error ? err.message : String(err) };
}

/**
 * A thin, host-agnostic controller over a {@link PluginSession}. Every method
 * maps one `sandy.*` tool: it validates the body against the tool schema,
 * delegates to the composed Sandy (gather/report/files/status), and shapes a
 * result. Confirmation-gated file ops return `needsConfirmation` instead of
 * acting — Sandy never decides for itself (FM-04).
 *
 * This is the seam the MCP server (plugin/mcp-server.ts) and any future host
 * bind to, so the tool logic is testable without the MCP transport.
 */
export class SandyPluginAPI {
  constructor(private readonly session: PluginSession) {}

  /** `sandy.gather` — fan out gather tasks, return provenance + gaps + progress. */
  async gather(input: unknown): Promise<GatherToolResult> {
    const body = validate("sandy.gather", gatherToolInput, input);
    const result = await this.run(toOrchestratorRequest({ goal: body.goal, gather: body.gather }));
    return { claims: result.claims, gaps: result.gaps, progress: result.progress };
  }

  /** `sandy.report` — gather, render, and write a confined report. */
  async report(input: unknown): Promise<ReportToolResult> {
    const body = validate("sandy.report", reportToolInput, input);
    const result = await this.run(
      toOrchestratorRequest({ goal: body.goal, gather: body.gather, report: body.report }),
    );
    return {
      claims: result.claims,
      gaps: result.gaps,
      progress: result.progress,
      reportPath: result.reportPath,
      reportContent: result.reportContent,
    };
  }

  private async run(request: ReturnType<typeof toOrchestratorRequest>): Promise<ReportToolResult> {
    const { progress, sandy } = this.session;
    progress.reset();
    const result: OrchestratorResult = await sandy.run(request);
    const events = progress.drain();
    return {
      claims: result.claims,
      gaps: result.gaps,
      progress: events,
      reportPath: result.reportPath,
      reportContent: result.reportContent,
    };
  }

  /** `sandy.status` — capability/health report (same shape as `sandy check --json`). */
  status(_input: unknown): StatusToolResult {
    validate("sandy.status", statusToolInput, _input);
    return this.session.sandy.check();
  }

  /**
   * `sandy.model.usage` — the host LLM (the engine, PL-03) reports its own model
   * usage so it lands in the audit trail (AU-01). Records the invocation and
   * returns the audit `seq` as a receipt. Metadata only: prompt/completion are
   * payloads (AU-02) and are not part of this tool's surface.
   */
  modelUsage(input: unknown): ModelUsageToolResult {
    const body = validate("sandy.model.usage", modelUsageInput, input);
    // An error in the body implies an error outcome unless one was given.
    const outcome = body.outcome ?? (body.error !== undefined ? "error" : "ok");
    const event = this.session.sandy.engine.record({
      ...(body.provider !== undefined ? { provider: body.provider } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.inputTokens !== undefined ? { inputTokens: body.inputTokens } : {}),
      ...(body.outputTokens !== undefined ? { outputTokens: body.outputTokens } : {}),
      ...(body.durationMs !== undefined ? { durationMs: body.durationMs } : {}),
      outcome,
      ...(body.error !== undefined ? { error: body.error } : {}),
    });
    return {
      recorded: true,
      seq: event.seq,
      provider: (event.data["provider"] as string) ?? "host",
      ...(body.inputTokens !== undefined ? { inputTokens: body.inputTokens } : {}),
      ...(body.outputTokens !== undefined ? { outputTokens: body.outputTokens } : {}),
      outcome,
    };
  }

  // --- files ---------------------------------------------------------------

  async filesRead(input: unknown): Promise<FilesReadResult> {
    const body = validate("sandy.files.read", filesReadInput, input);
    try {
      const r = await this.session.sandy.files.read(body.path);
      return { path: r.path, content: r.content, format: r.format };
    } catch (err) {
      return { path: body.path, error: fileError(err) };
    }
  }

  async filesList(input: unknown): Promise<FilesListResult> {
    const body = validate("sandy.files.list", filesListInput, input);
    try {
      const entries = await this.session.sandy.files.list(body.path, { recursive: body.recursive ?? false });
      return { path: body.path, entries };
    } catch (err) {
      return { path: body.path, error: fileError(err) };
    }
  }

  filesWrite(input: unknown): Promise<FilesMutateResult> {
    const body = validate("sandy.files.write", filesWriteInput, input);
    return this.mutate("sandy.files.write", () =>
      this.session.sandy.files.write(body.path, body.content, opOptions(body)),
    );
  }

  filesDelete(input: unknown): Promise<FilesMutateResult> {
    const body = validate("sandy.files.delete", filesDeleteInput, input);
    return this.mutate("sandy.files.delete", () =>
      body.kind === "file"
        ? this.session.sandy.files.deleteFile(body.path, opOptions(body))
        : this.session.sandy.files.deleteDirectory(body.path, opOptions(body)),
    );
  }

  filesMkdir(input: unknown): Promise<FilesMutateResult> {
    const body = validate("sandy.files.mkdir", filesMkdirInput, input);
    return this.mutate("sandy.files.mkdir", () =>
      this.session.sandy.files.createDirectory(body.path, opOptions(body)),
    );
  }

  filesRename(input: unknown): Promise<FilesMutateResult> {
    const body = validate("sandy.files.rename", filesRenameInput, input);
    return this.mutate("sandy.files.rename", () =>
      this.session.sandy.files.rename(body.from, body.to, opOptions(body)),
    );
  }

  /**
   * Wrap a mutating file op: a confirmation gate is a *prompt*, not a failure.
   * When the policy requires confirmation and none was supplied, return
   * `needsConfirmation` so the host can ask the user and re-invoke.
   */
  private async mutate(tool: string, op: () => Promise<FileMutationResult>): Promise<FilesMutateResult> {
    try {
      const result = await op();
      return { applied: result.applied, path: result.path, dryRun: !result.applied };
    } catch (err) {
      if (err instanceof ConfirmationRequiredError) {
        return {
          applied: false,
          path: err.attempted,
          dryRun: false,
          needsConfirmation: true,
          message: err.message,
        };
      }
      if (err instanceof FileOpError) {
        return { applied: false, path: err.attempted, dryRun: false, error: fileError(err) };
      }
      throw err;
    }
  }
}
