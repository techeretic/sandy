// A real streamable-HTTP MCP endpoint for egress conformance (network-level).
// Listens on a port and serves an MCP streamable-HTTP endpoint at /mcp exposing
// a `read_deals` tool. When EP_LOG is set, every request is appended to that
// file — this is the network-level "egress is observable" signal: the declared
// endpoint is the one actually hit, and it says so.
//
// Usage: node conformance/ep-server.mjs [port]   (EP_LOG=<file> to record)
// Prints the endpoint URL (http://127.0.0.1:PORT/mcp) to stdout on ready.
import { createServer } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Stateless streamable-HTTP: the SDK binds one protocol to one connection, so
// each request gets its own McpServer + transport. Each request is self-contained.
function buildServer() {
  const s = new McpServer({ name: "ep-crm", version: "1.0.0" });
  s.registerTool(
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
  return s;
}

const EP_LOG = process.env["EP_LOG"];
async function logRequest(req, body) {
  if (!EP_LOG) return;
  const method = req.method ?? "GET";
  const hasBody = body !== undefined;
  const line = `${new Date().toISOString()} ${method} ${req.url ?? "/"} body=${hasBody ? "yes" : "no"}\n`;
  await appendFile(EP_LOG, line).catch(() => {});
}

async function handle(req, res) {
  const body = await readBody(req);
  await logRequest(req, body);
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  try {
    await transport.handleRequest(req, res, body);
  } finally {
    await transport.close().catch(() => {});
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

if (EP_LOG) await mkdir(path.dirname(EP_LOG), { recursive: true }).catch(() => {});

const port = Number(process.argv[2] ?? 0);
const httpServer = createServer((req, res) => {
  if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
    handle(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  } else {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

await new Promise((resolve) => httpServer.listen(port, "0.0.0.0", resolve));
const actual = httpServer.address().port;
process.stdout.write(`http://0.0.0.0:${actual}/mcp\n`);
// Keep the process alive until killed; readiness is signaled via stdout above.
