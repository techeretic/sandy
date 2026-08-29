import path from "node:path";
import type { McpClientManager } from "../mcp/manager.js";
import type { AuditLogger } from "../audit/logger.js";
import type { FileManager } from "../files/file-manager.js";
import type { ReportFormat } from "./report.js";
import {
  Orchestrator,
  type OrchestratorOptions,
} from "./orchestrator.js";
import type { WriteApprovalGate } from "./write-gate.js";

export interface OrchestratorFactoryOptions {
  manager: McpClientManager;
  audit: AuditLogger;
  /** Confined file manager for writing reports into the sandbox. */
  files: FileManager;
  /** Directory (absolute or relative to the working root) for reports. */
  reportDir: string;
  /** Report format (issue #14). Default "markdown". */
  reportFormat?: ReportFormat;
  concurrency?: number;
  onProgress?: OrchestratorOptions["onProgress"];
  /**
   * The write-approval gate (issue #16 / Q6). Defaults to the ReadOnlyGate
   * inside the Orchestrator when omitted (refuse all writes, fail closed).
   */
  writeGate?: WriteApprovalGate;
}

/**
 * Build a ready-to-run Orchestrator wired to the real report renderer (in the
 * configured format, issue #14) and a File-Manager-backed, sandbox-confined
 * report writer (RG-02/RG-03).
 */
export function createOrchestrator(options: OrchestratorFactoryOptions): Orchestrator {
  const { manager, audit, files, reportDir, reportFormat, concurrency, onProgress, writeGate } = options;
  return new Orchestrator({
    manager,
    audit,
    concurrency,
    onProgress,
    reportFormat,
    writeGate,
    writeReport: async (content, file) => {
      const target = path.join(reportDir, file);
      // The File Manager confines the path and applies policy; report writes
      // are user-initiated artifacts, so they are confirmed here.
      const result = await files.write(target, content, { confirmed: true });
      return result.path;
    },
    // Binary report artifacts (docx/xlsx/pdf, issue #14) are written through
    // the File Manager's byte-exact writeBinary (magic-validated, journaled
    // as base64) — the same confinement and confirmation policy applies.
    writeBinaryReport: async (bytes, file) => {
      const target = path.join(reportDir, file);
      const result = await files.writeBinary(target, bytes, { confirmed: true });
      return result.path;
    },
  });
}
