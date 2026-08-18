// A minimal stdio MCP server for end-to-end CLI tests.
// Spawned by `sandy` (command: [node, <this file>]). Exposes `read_deals`.
// Plain ESM (.mjs) so it runs directly under the project's node without a build step.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "fixture-crm", version: "1.0.0" });

server.registerTool(
  "read_deals",
  {
    description: "Return a sample deals payload",
    inputSchema: z.record(z.string(), z.unknown()),
  },
  async (args) => {
    const parsed = args ?? {};
    const region = typeof parsed.region === "string" ? parsed.region : "all";
    return {
      content: [{ type: "text", text: `2 deals closed in ${region} this quarter.` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
