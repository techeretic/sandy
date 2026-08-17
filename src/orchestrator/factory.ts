import path from "node:path";
import type { McpClientManager } from "../mcp/manager.js";
import type { AuditLogger } from "../audit/logger.js";
import type { FileManager } from "../files/file-manager.js";
import { renderMarkdownReport } from "./report.js";
import {
  Orchestrator,
  type OrchestratorOptions,
} from "./orchestrator.js";

export interface OrchestratorFactoryOptions {
  manager: McpClientManager;
  audit: AuditLogger;
  /** Confined file manager for writing reports into the sandbox. */
  files: FileManager;
  /** Directory (absolute or relative to the working root) for reports. */
  reportDir: string;
  concurrency?: number;
  onProgress?: OrchestratorOptions["onProgress"];
}

/**
 * Build a ready-to-run Orchestrator wired to the real report renderer and a
 * File-Manager-backed, sandbox-confined report writer (RG-02/RG-03).
 */
export function createOrchestrator(options: OrchestratorFactoryOptions): Orchestrator {
  const { manager, audit, files, reportDir, concurrency, onProgress } = options;
  return new Orchestrator({
    manager,
    audit,
    concurrency,
    onProgress,
    renderReport: renderMarkdownReport,
    writeReport: async (content, file) => {
      const target = path.join(reportDir, file);
      // The File Manager confines the path and applies policy; report writes
      // are user-initiated artifacts, so they are confirmed here.
      const result = await files.write(target, content, { confirmed: true });
      return result.path;
    },
  });
}
