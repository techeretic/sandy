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
import { PolicyApprovalGate, type WriteApproval, type WriteTask } from "../orchestrator/write-gate.js";
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
  writeApproveInput,
  writeRevokeInput,
  writeToolInput,
  type FilesListResult,
  type FilesMutateResult,
  type FilesReadResult,
  type GatherToolResult,
  type ModelUsageToolResult,
  type PendingWriteApproval,
  type ReportToolResult,
  type StatusToolResult,
  type WriteApproveResult,
  type WriteRevokeResult,
  type WriteToolResult,
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

  /**
   * `sandy.write` — write-back to internal systems (issue #16 / Q6). Each task
   * must pass the session's write gate — the admin write allowlist (and its
   * per-arg constraints), AND an explicit, per-write approval — before it
   * reaches a server. The approval is single-use: the gate consumes it, and
   * re-presenting the same approval is refused. An approval may be passed
   * inline (`approvals`) OR recorded ahead of time with `sandy.write.approve`
   * (the consent flow) — the gate resolves either.
   *
   * Never auto-confirm (FM-04): a task without a valid approval is refused
   * with `no-approval` and audited — it is never executed. A refused write is
   * terminal (contract point 5): it is reported in the result, never retried.
   */
  async write(input: unknown): Promise<WriteToolResult> {
    const body = validate("sandy.write", writeToolInput, input);
    const gate = this.session.sandy.writeGate;
    const taskIds = new Set(body.tasks.map((t) => t.id));
    const approvals: Record<string, WriteApproval> = {};
    for (const [taskId, approval] of Object.entries(body.approvals ?? {})) {
      // Only pass approvals for a task in THIS call — a stray approval is
      // dropped, never banked for a later write.
      if (!taskIds.has(taskId)) continue;
      approvals[taskId] = {
        taskId,
        approver: approval.approver,
        reason: approval.reason,
        ...(approval.expiresAt !== undefined ? { expiresAt: approval.expiresAt } : {}),
      };
    }
    const tasks: WriteTask[] = body.tasks.map((t) => ({
      id: t.id,
      server: t.server,
      tool: t.tool,
      args: t.args,
    }));
    const results = await this.session.sandy.write(tasks, approvals);
    // The consent flow (issue #16 v2): with a policy gate, a write that is
    // legal (allowlisted, args within the entry's constraints) but was not
    // executed because no valid approval was presented is surfaced as
    // `needsApproval` — the host asks the user and re-invokes with an
    // approval for exactly these tasks (the same taskId + args; the
    // re-presented approval is consumed, so it stays single-use). A task that
    // is not allowlisted, whose args fall outside the policy's constraints, or
    // that hit the read-only gate is a POLICY refusal, not a consent gap — it
    // is NOT listed (asking the user could not make it legal).
    let needsApproval: PendingWriteApproval[] | undefined;
    if (gate instanceof PolicyApprovalGate) {
      const ttl = gate.approvalTtlSeconds();
      const pending = tasks.filter((t, i) => {
        const reason = results[i]!.reason;
        return (
          !results[i]!.allowed &&
          (reason === "no-approval" || reason === "approval-expired" || reason === "approval-revoked")
        );
      });
      if (pending.length > 0) {
        needsApproval = pending.map((t) => ({
          taskId: t.id,
          server: t.server,
          tool: t.tool,
          args: t.args,
          approvalTtlSeconds: ttl,
        }));
      }
    }
    return {
      results,
      ...(needsApproval !== undefined ? { needsApproval } : {}),
    };
  }

  /**
   * `sandy.write.approve` — record a write approval ahead of time (issue #16
   * v2: the consent flow). The host gets the user's consent, records it here,
   * and a later `sandy.write` for the same task then proceeds on that
   * approval. The receipt carries the computed `expiresAt` so the host can
   * tell the user how long the consent lasts. The approval is single-use and
   * time-bound; re-recording the same (taskId, approver) is refused.
   */
  writeApprove(input: unknown): WriteApproveResult {
    const body = validate("sandy.write.approve", writeApproveInput, input);
    const gate = this.session.sandy.writeGate;
    if (!(gate instanceof PolicyApprovalGate)) {
      // No policy gate (read-only posture) ⇒ there is nothing to approve.
      return { approved: false, reason: "write-back is not enabled (no write allowlist configured)" };
    }
    const approval: WriteApproval = {
      taskId: body.taskId,
      approver: body.approver,
      reason: body.reason,
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
    };
    if (!gate.approve(approval)) {
      return { approved: false, reason: "approval already recorded or revoked for this (taskId, approver)" };
    }
    const expiresAt = gate.pendingExpiry(body.taskId, body.approver);
    return {
      approved: true,
      ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      approvalTtlSeconds: gate.approvalTtlSeconds(),
    };
  }

  /**
   * `sandy.write.revoke` — withdraw a write approval before it is used
   * (issue #16 v2: the user can revoke consent). With `approver` given, only
   * that approver's approval for the task is revoked; without it, every
   * pending approval for the task is. After a successful revoke the pair can
   * never approve a write again — presenting it is refused with
   * `approval-revoked`.
   */
  writeRevoke(input: unknown): WriteRevokeResult {
    const body = validate("sandy.write.revoke", writeRevokeInput, input);
    const gate = this.session.sandy.writeGate;
    if (!(gate instanceof PolicyApprovalGate)) {
      // No policy gate (read-only posture) ⇒ there is no approval to revoke.
      return { revoked: 0 };
    }
    return { revoked: gate.revoke(body.taskId, body.approver) };
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
