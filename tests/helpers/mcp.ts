import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServer as McpServerConfig } from "../../src/index.js";

/** A tool exposed by a test server. */
export interface TestTool {
  name: string;
  /** If set, the tool handler throws (the error surfaces as an isError result). */
  fail?: boolean;
  /**
   * Custom response. Receives the (parsed) tool args. If omitted, the tool
   * echoes its args as a JSON text block.
   */
  respond?: (args: Record<string, unknown>) => string;
}

export interface TestServer {
  name: string;
  /** Client-side transport to hand to a transportFactory. */
  transport: Transport;
  /** Call counts per tool name. */
  calls: Map<string, number>;
  /** Last args received per tool name. */
  lastArgs: Map<string, Record<string, unknown>>;
  close: () => Promise<void>;
}

/** Stand up an in-process MCP server exposing the given tools. */
export async function makeInMemoryServer(
  name: string,
  tools: TestTool[],
): Promise<TestServer> {
  const server = new McpServer({ name: `test-${name}`, version: "1.0.0" });
  const calls = new Map<string, number>();
  const lastArgs = new Map<string, Record<string, unknown>>();
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: `test tool ${tool.name}`, inputSchema: z.record(z.string(), z.unknown()) },
      async (args: unknown) => {
        const parsed = (args ?? {}) as Record<string, unknown>;
        calls.set(tool.name, (calls.get(tool.name) ?? 0) + 1);
        lastArgs.set(tool.name, parsed);
        if (tool.fail) throw new Error(`boom from ${tool.name}`);
        const text = tool.respond ? tool.respond(parsed) : JSON.stringify(parsed);
        return { content: [{ type: "text", text }] };
      },
    );
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return {
    name,
    transport: clientTransport,
    calls,
    lastArgs,
    close: async () => {
      await server.close();
      await clientTransport.close();
    },
  };
}

/** Build a config object for an in-test MCP server. */
export function serverConfig(
  name: string,
  tools: string[],
  over: Partial<Record<string, unknown>> = {},
): McpServerConfig {
  return {
    name,
    transport: "stdio",
    command: ["true"],
    version: "1.0.0",
    capabilities: tools,
    allowed_tools: tools,
    ...over,
  } as McpServerConfig;
}

/** Zero-delay retry policy for fast tests. */
export const instantRetry = {
  maxRetries: 2,
  baseDelayMs: 1,
  factor: 1,
  maxDelayMs: 1,
  sleep: async () => {},
} as const;
