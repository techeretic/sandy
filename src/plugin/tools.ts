import { z } from "zod";
import type { Claim, Gap } from "../orchestrator/orchestrator.js";
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
