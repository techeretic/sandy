import { z } from "zod";
import type { Claim, Gap, WriteResult } from "../orchestrator/orchestrator.js";
import type { SandyCheckReport } from "../sandy.js";
import { gatherTaskSchema } from "../orchestrator/request.js";

/**
 * The plugin's host-side tool surface (PL-02/PL-03).
 *
 * In plugin mode the host LLM (Claude Code / Codex) does the reasoning. Sandy
 * exposes a small set of sandboxed capabilities the host can call. This module
 * is the host-agnostic *contract*: the Zod input schemas (used to validate
 * every tool body AND to register the MCP tools) and the result types. The
 * MCP server (plugin/mcp-server.ts) and any other host bind to this, so there
 * is exactly one definition of what each tool accepts and returns.
 *
 * Naming: tools are namespaced `sandy.*` (PL-04: the plugin is "Sandy").
 */

// --- shared bits -----------------------------------------------------------

/** One gather unit: a single tool call on one MCP server (same shape as the CLI request). */
export const gatherTaskShape = gatherTaskSchema.shape;

export type GatherTaskInput = z.infer<typeof gatherTaskSchema>;

// --- sandy.gather ----------------------------------------------------------

export const gatherToolInput = z
  .object({
    goal: z.string().min(1).describe("What the user asked for, in their words"),
    gather: z.array(gatherTaskSchema).min(1, { message: "at least one gather task is required" }),
  })
  .strict();

export interface GatherToolResult {
  claims: Claim[];
  gaps: Gap[];
  /** Progress events collected during the run (Q4). Host may surface or ignore. */
  progress: string[];
}

// --- sandy.report ----------------------------------------------------------

export const reportToolInput = z
  .object({
    goal: z.string().min(1).describe("What the user asked for, in their words"),
    gather: z.array(gatherTaskSchema).min(1, { message: "at least one gather task is required" }),
    report: z
      .object({
        title: z.string().min(1).optional(),
        file: z.string().min(1).optional(),
        summary: z.string().min(1).optional().describe("Host-LLM narrative; claims remain independently traceable"),
      })
      .strict(),
  })
  .strict();

export interface ReportToolResult extends GatherToolResult {
  reportPath?: string;
  reportContent?: string;
}

// --- sandy.write -----------------------------------------------------------

/**
 * One write-back task: a single tool call on one MCP server that MUTATES
 * internal state (issue #16 / Q6). Distinct from a gather task — a write
 * must pass the write-approval gate before it is routed anywhere.
 */
export const writeTaskInput = z
  .object({
    id: z.string().min(1).describe("Stable id used in the audit trail"),
    server: z.string().min(1).describe("MCP server name"),
    tool: z.string().min(1).describe("Mutating tool to call on that server"),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type WriteTaskInput = z.infer<typeof writeTaskInput>;

/**
 * An explicit, per-write human approval (Q6 contract point 3). The host asks
 * the USER and only then fills this in — Sandy never creates one itself
 * (FM-04: never auto-confirm). The approval is single-use: it is bound to
 * exactly one task id and consumed by the gate.
 */
export const writeApprovalShape = {
  approver: z
    .string()
    .min(1)
    .describe("Who approved — the human principal or an approved automation's identity"),
  reason: z.string().min(1).describe("Why the write was approved (audited)"),
  expiresAt: z
    .string()
    .optional()
    .describe(
      "Optional explicit expiry (ISO-8601). Without it the policy's approval TTL applies. May only shorten the default window, never extend it.",
    ),
} as const;

export type WriteApprovalInput = z.infer<typeof writeApprovalShape>;

export const writeToolInput = z
  .object({
    tasks: z.array(writeTaskInput).min(1, { message: "at least one write task is required" }),
    /**
     * Per-task approvals, keyed by task id. A task with no approval (or a
     * mismatched/consumed one) is refused with `no-approval` — never
     * auto-approved.
     */
    approvals: z
      .record(z.string(), z.object(writeApprovalShape))
      .optional(),
  })
  .strict();

/**
 * The outcome of one write task — the orchestrator's {@link WriteResult}
 * (issue #16 / Q6): a refused write is a terminal, audited rejection, never a
 * silent retry.
 */
export type WriteTaskResult = WriteResult;

/**
 * A write that is legal (allowlisted, args within constraints) but has not
 * been approved yet (issue #16 v2 — the in-band consent flow). The host must
 * surface this to the user and re-invoke `sandy.write` with an approval for
 * the same (taskId, args); it may also be revoked by the user before then.
 */
export interface PendingWriteApproval {
  taskId: string;
  server: string;
  tool: string;
  /** The exact args the approval will be bound to. */
  args: Record<string, unknown>;
  /** How long the approval, once given, stays usable (policy TTL). */
  approvalTtlSeconds: number;
}

export interface WriteToolResult {
  results: WriteResult[];
  /**
   * Set when at least one task was legal but unapproved (or the user's
   * approval was missing/expired/revoked). The host asks the user and
   * re-invokes with `approvals` for the listed tasks. Never set alongside a
   * task that was executed.
   */
  needsApproval?: PendingWriteApproval[];
}

/**
 * Record a write approval ahead of time (issue #16 v2 — the consent flow).
 * The host gets the user's consent, records it here, and a later `sandy.write`
 * for the same task then proceeds on that approval (no need to re-pass it).
 * The approval is single-use and time-bound; re-recording the same
 * (taskId, approver) is refused.
 */
export const writeApproveInput = z
  .object(writeApprovalShape)
  .extend({
    taskId: z.string().min(1).describe("The write task id the approval is bound to"),
  })
  .strict();

export interface WriteApproveResult {
  /** True when the approval was recorded; false when it was refused (duplicate / revoked). */
  approved: boolean;
  /** When refused, why. */
  reason?: string;
  /** When approved, when the approval stops being usable (the earlier of the given `expiresAt` and the default TTL window). */
  expiresAt?: string;
  /** The default approval TTL in seconds, for the host to show the user. */
  approvalTtlSeconds?: number;
}

/**
 * Revoke a write approval before it is used (issue #16 v2 — the user can
 * withdraw consent). With `approver` given, only that approver's approval for
 * the task is revoked; without it, every pending approval for the task is.
 * A revoked (taskId, approver) pair can never approve a write again
 * afterwards.
 */
export const writeRevokeInput = z
  .object({
    taskId: z.string().min(1).describe("The write task id to revoke approvals for"),
    approver: z
      .string()
      .min(1)
      .optional()
      .describe("Limit the revocation to this approver (default: all pending approvals for the task)"),
  })
  .strict();

export interface WriteRevokeResult {
  /** How many pending approvals were revoked (0 when there was nothing to revoke). */
  revoked: number;
}

// --- sandy.status ----------------------------------------------------------

export const statusToolInput = z.object({}).strict();

/** Reuses the CLI capability/health report — one source of truth. */
export type StatusToolResult = SandyCheckReport;

// --- sandy.model.usage -----------------------------------------------------

/**
 * In plugin mode the HOST LLM is the engine (PL-03). This tool is how the host
 * reports its own model usage back to Sandy so it lands in the audit trail
 * (AU-01: "every model invocation with token counts"). The host is the one that
 * knows its token counts; Sandy records them. Metadata only — prompt/completion
 * are payloads (AU-02, opt-in) and are deliberately NOT part of the tool surface.
 */
export const modelUsageShape = {
  provider: z
    .string()
    .min(1)
    .optional()
    .describe("Model provider label, e.g. 'claude-code'. Defaults to 'host'."),
  model: z.string().min(1).optional().describe("Model name/id, when the host exposes it"),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Defaults to "error" when an `error` is present, else "ok". */
  outcome: z.enum(["ok", "error"]).optional(),
  error: z.string().min(1).optional(),
} as const;

export const modelUsageInput = z
  .object(modelUsageShape)
  .strict()
  .refine(
    (b) =>
      b.inputTokens !== undefined ||
      b.outputTokens !== undefined ||
      b.error !== undefined,
    { message: "report at least one token count, or an error" },
  );

/** A receipt that the host's model usage was recorded in the audit log. */
export interface ModelUsageToolResult {
  recorded: true;
  /** Audit event sequence number — the receipt that the invocation was logged. */
  seq: number;
  provider: string;
  inputTokens?: number;
  outputTokens?: number;
  outcome: "ok" | "error";
}

// --- sandy.files.* ---------------------------------------------------------

export const fileOpFlagsShape = {
  /**
   * Set only when the human user has explicitly confirmed a confirmation-gated
   * operation. Sandy never auto-confirms; it returns `needsConfirmation` until
   * the host gets a real confirmation from the user (FM-04).
   */
  confirmed: z.boolean().optional(),
  /** Plan only; no filesystem changes (FM-06). */
  dryRun: z.boolean().optional(),
} as const;

/** Merge a base tool shape with the optional file-op flags into one strict object. */
function withFileFlags<T extends Record<string, z.ZodType>>(base: T): z.ZodObject<T & typeof fileOpFlagsShape> {
  return z.object({ ...base, ...fileOpFlagsShape }) as z.ZodObject<T & typeof fileOpFlagsShape>;
}

/** A structured, host-readable failure. Every `sandy.files.*` tool reports
 * errors this way rather than throwing — an LLM reads the result, so a thrown
 * error would be lost. */
export interface FilesError {
  reason: string;
  detail: string;
}

export const filesReadInput = withFileFlags({ path: z.string().min(1) });

export interface FilesReadResult {
  path: string;
  content?: string;
  format?: string;
  error?: FilesError;
}

export const filesListInput = withFileFlags({
  path: z.string().min(1),
  recursive: z.boolean().optional(),
});

export interface FilesListResult {
  path: string;
  entries?: string[];
  error?: FilesError;
}

export const filesWriteInput = withFileFlags({
  path: z.string().min(1),
  content: z.string(),
});

export const filesDeleteInput = withFileFlags({
  path: z.string().min(1),
  kind: z.enum(["file", "directory"]),
});

export const filesMkdirInput = withFileFlags({ path: z.string().min(1) });

export const filesRenameInput = withFileFlags({
  from: z.string().min(1),
  to: z.string().min(1),
});

/**
 * The common result for every mutating `sandy.files.*` tool. `needsConfirmation`
 * is true when the policy gated the op and no (valid) confirmation was
 * supplied — the host must then surface the prompt to the user and re-invoke
 * with `confirmed: true`. Sandy never decides for itself.
 */
export interface FilesMutateResult {
  applied: boolean;
  path: string;
  dryRun: boolean;
  needsConfirmation?: boolean;
  message?: string;
  /** Present when the op was rejected (violation / io / not-found / ignored). */
  error?: FilesError;
}

export type { Claim, Gap };
