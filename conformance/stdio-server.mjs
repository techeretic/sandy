// A stdio MCP server for the SANDBOX conformance matrix (SB-09/10).
//
// stdio is used (not HTTP) so the same fixture runs identically inside a
// Docker container and inside a Firejail jail — no network is required, so the
// matrix isolates the *boundary* behavior (detection, confinement, capability
// report, provenance) rather than conflating it with egress. The point of the
// matrix is to prove the enforcer is runtime-agnostic: same input, same
// behavior, whatever boundary is enforcing it.
//
// Mirrors tests/fixtures/stdio-mcp-server.mjs. Exposes `read_deals`.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "conformance-crm", version: "1.0.0" });

server.registerTool(
  "read_deals",
  {
    description: "Return a sample deals payload",
    inputSchema: z.record(z.string(), z.unknown()),
  },
  async (args) => {
    const parsed = args ?? {};
    const region = typeof parsed.region === "string" ? parsed.region : "all";
    return { content: [{ type: "text", text: `2 deals closed in ${region} this quarter.` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
