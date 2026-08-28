import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  filesDeleteInput,
  filesListInput,
  filesMkdirInput,
  filesReadInput,
  filesRenameInput,
  filesWriteInput,
  gatherToolInput,
  modelUsageShape,
  reportToolInput,
  statusToolInput,
  writeApproveInput,
  writeRevokeInput,
  writeToolInput,
} from "./tools.js";

/**
 * The Sandy MCP server — how a host (Claude Code / Codex) reaches Sandy in
 * plugin mode (PL-01/PL-02).
 *
 * It is a thin adapter: each `sandy.*` tool is registered with its Zod shape
 * (from plugin/tools.ts — the single source of truth for the tool surface) and
 * its handler delegates to {@link SandyPluginAPI}. All the sandboxing, MCP
 * orchestration, file confinement, and audit logging happen inside Sandy; the
 * host LLM only ever sees provenance + gaps and can act on the declared
 * capabilities (PL-03).
 *
 * The server runs over stdio and is long-lived: one per host session. It binds
 * to exactly one `sandy.json`.
 */
export interface SandyMcpServerOptions {
  api: import("./api.js").SandyPluginAPI;
}

export function createSandyMcpServer(options: SandyMcpServerOptions): McpServer {
  const { api } = options;
  const server = new McpServer({ name: "sandy", version: "0.1.2" });

  // Wrap a host-facing handler so its result is JSON-encoded into an MCP text
  // block, and any error is surfaced in-band (an LLM reads the tool result, so
  // a thrown error is lost; a ToolInputError carries field-level issues the
  // host can act on).
  type ToolContent = { content: Array<{ type: "text"; text: string }> };
  const text = (data: unknown): ToolContent => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  });
  const wrap =
    (fn: (args: Record<string, unknown>) => Promise<unknown> | unknown): ((args: Record<string, unknown>) => Promise<ToolContent>) =>
    async (args) => {
      try {
        return text(await fn(args));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return text({ error: message, isError: true });
      }
    };

  server.registerTool(
    "sandy.gather",
    {
      description:
        "Gather data from declared internal services via MCP servers. Returns provenance-tracked claims and explicit gaps (never fabricated).",
      inputSchema: gatherToolInput.shape,
    },
    wrap((args) => api.gather(args)),
  );

  server.registerTool(
    "sandy.report",
    {
      description:
        "Gather data and produce a provenance-tracked Markdown report written inside the sandbox. Returns the report path, content, claims, and gaps.",
      inputSchema: reportToolInput.shape,
    },
    wrap((args) => api.report(args)),
  );

  server.registerTool(
    "sandy.status",
    {
      description:
        "Report Sandy's health: sandbox runtime + capability (reduced-mode) report and MCP server connectivity.",
      inputSchema: statusToolInput.shape,
    },
    wrap((args) => api.status(args)),
  );

  server.registerTool(
    "sandy.model.usage",
    {
      description:
        "Report this host LLM's own model usage (token counts) so it is recorded in Sandy's audit log (AU-01). " +
        "The host is the engine (PL-03); call this after a turn to log its model invocation. Returns the audit seq.",
      inputSchema: modelUsageShape,
    },
    wrap((args) => api.modelUsage(args)),
  );

  server.registerTool(
    "sandy.write",
    {
      description:
        "Write back to an internal system via an MCP tool. Approval-gated (Q6): each task must be on the admin write allowlist AND carry an explicit per-write approval " +
        "(ask the user first; approvals are single-use, time-bound, and audited). Tasks without a valid approval are refused, never auto-approved — " +
        "the result's needsApproval lists the legal-but-unapproved tasks for you to put to the user.",
      inputSchema: writeToolInput.shape,
    },
    wrap((args) => api.write(args)),
  );

  server.registerTool(
    "sandy.write.approve",
    {
      description:
        "Record a per-write approval ahead of time (the user's consent, Q6). A later sandy.write for the same task then proceeds on it. Approvals are single-use and time-bound; the result's expiresAt says how long the consent lasts.",
      inputSchema: writeApproveInput.shape,
    },
    wrap((args) => api.writeApprove(args)),
  );

  server.registerTool(
    "sandy.write.revoke",
    {
      description:
        "Revoke a pending write approval before it is used (the user withdraws consent). With approver given, only that approver's approval is revoked; without it, every pending approval for the task. A revoked pair can never approve a write again.",
      inputSchema: writeRevokeInput.shape,
    },
    wrap((args) => api.writeRevoke(args)),
  );

  server.registerTool(
    "sandy.files.read",
    { description: "Read a text file inside the sandbox working root.", inputSchema: filesReadInput.shape },
    wrap((args) => api.filesRead(args)),
  );

  server.registerTool(
    "sandy.files.list",
    { description: "List entries under a directory inside the sandbox.", inputSchema: filesListInput.shape },
    wrap((args) => api.filesList(args)),
  );

  server.registerTool(
    "sandy.files.write",
    {
      description:
        "Create or overwrite a file inside the sandbox. Confirmation-gated ops return needsConfirmation.",
      inputSchema: filesWriteInput.shape,
    },
    wrap((args) => api.filesWrite(args)),
  );

  server.registerTool(
    "sandy.files.delete",
    {
      description: "Delete a file or directory inside the sandbox. Confirmation-gated.",
      inputSchema: filesDeleteInput.shape,
    },
    wrap((args) => api.filesDelete(args)),
  );

  server.registerTool(
    "sandy.files.mkdir",
    { description: "Create a directory inside the sandbox. Confirmation-gated by policy.", inputSchema: filesMkdirInput.shape },
    wrap((args) => api.filesMkdir(args)),
  );

  server.registerTool(
    "sandy.files.rename",
    { description: "Rename/move a file or directory inside the sandbox. Confirmation-gated.", inputSchema: filesRenameInput.shape },
    wrap((args) => api.filesRename(args)),
  );

  return server;
}

/**
 * Build and start the stdio Sandy MCP server for a config path. Intended as a
 * module entry point: `node dist/plugin/mcp-server.js <sandy.json>`.
 */
export async function startSandyMcpServer(
  configPath: string,
  transport: Transport = new StdioServerTransport(),
): Promise<McpServer> {
  const { SessionCache } = await import("./state.js");
  const { SandyPluginAPI } = await import("./api.js");
  const cache = new SessionCache({});
  const session = await cache.get(configPath);
  const api = new SandyPluginAPI(session);
  const server = createSandyMcpServer({ api });
  await server.connect(transport);
  return server;
}

// Entry point: `node dist/plugin/mcp-server.js <sandy.json>`.
// Guarded so importing this module (tests) never starts a server.
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const entry = process.argv[1];
const isDirectRun = !!entry && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
if (isDirectRun) {
  const configPath = path.resolve(process.argv[2] ?? process.env["SANDY_CONFIG"] ?? "sandy.json");
  startSandyMcpServer(configPath).catch((err) => {
    process.stderr.write(`sandy mcp-server: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
