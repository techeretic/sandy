import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import {
  McpClientManager,
  McpCallError,
  NetworkEgressError,
  NetworkGuard,
  SecretResolver,
  guardedFetch,
  withRetry,
  resolveRetryPolicy,
  type McpAuditSink,
  type McpCallRecord,
} from "../src/index.js";
import {
  makeInMemoryServer,
  serverConfig,
  instantRetry,
  type TestServer,
} from "./helpers/mcp.js";

const resolver = new SecretResolver({ SOME_TOKEN: "tok-123" });

/** Wraps a real transport and fails the first N tools/call sends. */
class FlakyTransport implements Transport {
  private remaining: number;
  attempts = 0;

  constructor(
    private readonly inner: Transport,
    failures: number,
  ) {
    this.remaining = failures;
  }

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  sessionId?: string;

  start(): Promise<void> {
    this.inner.onclose = this.onclose;
    this.inner.onerror = this.onerror;
    this.inner.onmessage = this.onmessage;
    this.sessionId = this.inner.sessionId;
    return this.inner.start();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const isCall = "method" in message && message.method === "tools/call";
    if (isCall) {
      this.attempts++;
      if (this.remaining > 0) {
        this.remaining--;
        throw new Error("socket hang up");
      }
    }
    return this.inner.send(message);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

class RecordingAudit implements McpAuditSink {
  entries: McpCallRecord[] = [];
  record(entry: McpCallRecord): void {
    this.entries.push(entry);
  }
}


describe("McpClientManager", () => {
  it("connects multiple servers in one session (MCP-04)", async () => {
    const a = await makeInMemoryServer("a", [{ name: "read_a" }]);
    const b = await makeInMemoryServer("b", [{ name: "read_b" }]);
    const manager = new McpClientManager(
      [serverConfig("a", ["read_a"]), serverConfig("b", ["read_b"])],
      resolver,
      new NetworkGuard([]),
      {
        retry: instantRetry,
        transportFactory: (cfg) => (cfg.name === "a" ? a.transport : b.transport),
      },
    );
    try {
      const result = await manager.connectAll();
      expect(result.ok.sort()).toEqual(["a", "b"]);
      expect(result.failed).toEqual([]);
      const health = manager.health();
      expect(health.connected.sort()).toEqual(["a", "b"]);
      const out = await manager.callTool("b", "read_b", { q: 1 });
      const text = (out as Array<{ text: string }>).at(0)?.text;
      expect(JSON.parse(text ?? "null")).toMatchObject({ q: 1 });
    } finally {
      await manager.close();
      await a.close();
      await b.close();
    }
  });

  it("reports degraded health when an allowed tool is missing on the server (MCP-03/09)", async () => {
    const a = await makeInMemoryServer("a", [{ name: "real_tool" }]);
    const manager = new McpClientManager(
      [serverConfig("a", ["real_tool", "ghost_tool"])],
      resolver,
      new NetworkGuard([]),
      { retry: instantRetry, transportFactory: () => a.transport },
    );
    try {
      await manager.connectAll();
      const health = manager.health();
      expect(health.connected).toEqual([]);
      expect(health.degraded).toHaveLength(1);
      expect(health.degraded[0]?.detail).toContain("ghost_tool");
    } finally {
      await manager.close();
      await a.close();
    }
  });

  it("treats a startup connection failure as terminal and explicit (MCP-10)", async () => {
    const a = await makeInMemoryServer("a", [{ name: "read_a" }]);
    const manager = new McpClientManager(
      [serverConfig("a", ["read_a"]), serverConfig("broken", ["x"])],
      resolver,
      new NetworkGuard([]),
      {
        retry: instantRetry,
        transportFactory: (cfg) => {
          if (cfg.name === "broken") {
            const dead: Transport = {
              start: async () => {
                throw new Error("connect ECONNREFUSED 127.0.0.1:9");
              },
              send: async () => {
                throw new Error("closed");
              },
              close: async () => {},
            };
            return dead;
          }
          return a.transport;
        },
      },
    );
    try {
      const result = await manager.connectAll();
      expect(result.ok).toEqual(["a"]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.server).toBe("broken");
      expect(result.failed[0]?.error).toContain("ECONNREFUSED");
      expect(manager.failedServers[0]?.server).toBe("broken");
      expect(() => manager.getServer("broken")).toThrow(/failed to connect at startup/);
      // The healthy server is still usable.
      await expect(manager.callTool("a", "read_a", {})).resolves.toBeDefined();
    } finally {
      await manager.close();
      await a.close();
    }
  });

  it("refuses calls to tools outside the allowlist before they reach the wire (MCP-07)", async () => {
    const a = await makeInMemoryServer("a", [{ name: "allowed" }, { name: "forbidden" }]);
    const manager = new McpClientManager(
      [serverConfig("a", ["allowed", "forbidden"], { allowed_tools: ["allowed"] })],
      resolver,
      new NetworkGuard([]),
      { retry: instantRetry, transportFactory: () => a.transport },
    );
    try {
      await manager.connectAll();
      const err = await manager.callTool("a", "forbidden", {}).catch((e) => e);
      expect(err).toBeInstanceOf(McpCallError);
      expect((err as McpCallError).reason).toBe("tool-not-allowed");
      expect(a.calls.get("forbidden")).toBeUndefined();
      await expect(manager.callTool("a", "allowed", {})).resolves.toBeDefined();
      expect(a.calls.get("allowed")).toBe(1);
    } finally {
      await manager.close();
      await a.close();
    }
  });

  it("retries transient failures with backoff then succeeds (MCP-11)", async () => {
    const server = await makeInMemoryServer("a", [{ name: "read_a" }]);
    const flaky = new FlakyTransport(server.transport, 2);
    const manager = new McpClientManager(
      [serverConfig("a", ["read_a"])],
      resolver,
      new NetworkGuard([]),
      { retry: instantRetry, transportFactory: () => flaky },
    );
    try {
      await manager.connectAll();
      await expect(manager.callTool("a", "read_a", {})).resolves.toBeDefined();
      expect(flaky.attempts).toBe(3);
    } finally {
      await manager.close();
      await server.close();
    }
  });

  it("gives up after max retries and reports degraded health (MCP-09)", async () => {
    const server = await makeInMemoryServer("a", [{ name: "read_a" }]);
    const flaky = new FlakyTransport(server.transport, 99);
    const manager = new McpClientManager(
      [serverConfig("a", ["read_a"])],
      resolver,
      new NetworkGuard([]),
      { retry: instantRetry, transportFactory: () => flaky },
    );
    try {
      await manager.connectAll();
      const err = await manager.callTool("a", "read_a", {}).catch((e) => e);
      expect(err).toBeInstanceOf(McpCallError);
      expect((err as McpCallError).reason).toBe("transport");
      expect(flaky.attempts).toBe(3);
      expect(server.calls.get("read_a")).toBeUndefined();
      expect(manager.getServer("a").getHealth().state).toBe("degraded");
    } finally {
      await manager.close();
      await server.close();
    }
  });

  it("does not retry protocol-level errors (single attempt)", async () => {
    const server = await makeInMemoryServer("a", [{ name: "boom", fail: true }]);
    const flaky = new FlakyTransport(server.transport, 0);
    const manager = new McpClientManager(
      [serverConfig("a", ["boom"])],
      resolver,
      new NetworkGuard([]),
      { retry: instantRetry, transportFactory: () => flaky },
    );
    try {
      await manager.connectAll();
      const err = await manager.callTool("a", "boom", {}).catch((e) => e);
      expect(err).toBeInstanceOf(McpCallError);
      expect((err as McpCallError).reason).toBe("protocol");
      expect(flaky.attempts).toBe(1);
    } finally {
      await manager.close();
      await server.close();
    }
  });

  it("audits every call with args-by-hash only, never raw values (AU-02/MCP-12)", async () => {
    const a = await makeInMemoryServer("a", [{ name: "read_a" }]);
    const audit = new RecordingAudit();
    const manager = new McpClientManager(
      [serverConfig("a", ["read_a"])],
      resolver,
      new NetworkGuard([]),
      { retry: instantRetry, audit, transportFactory: () => a.transport },
    );
    try {
      await manager.connectAll();
      await manager.callTool("a", "read_a", { secret: "hunter2" });
      expect(audit.entries).toHaveLength(1);
      const entry = audit.entries[0] as { server: string; tool: string; argsHash: string; outcome: string };
      expect(entry.server).toBe("a");
      expect(entry.tool).toBe("read_a");
      expect(entry.outcome).toBe("ok");
      expect(entry.argsHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(audit.entries)).not.toContain("hunter2");
    } finally {
      await manager.close();
      await a.close();
    }
  });

  it("close() is idempotent and disables further calls", async () => {
    const a = await makeInMemoryServer("a", [{ name: "read_a" }]);
    const manager = new McpClientManager(
      [serverConfig("a", ["read_a"])],
      resolver,
      new NetworkGuard([]),
      { retry: instantRetry, transportFactory: () => a.transport },
    );
    await manager.connectAll();
    await manager.close();
    await manager.close();
    expect(manager.connectedNames).toEqual([]);
    expect(() => manager.getServer("a")).toThrow(/unknown MCP server/);
    await a.close();
  });
});

describe("guardedFetch", () => {
  const guard = new NetworkGuard(["api.internal:8443"]);
  const seen: string[] = [];
  const inner: typeof globalThis.fetch = async (input) => {
    seen.push(String(input));
    return new Response("ok");
  };

  it("allows declared endpoints and passes through to the inner fetch", async () => {
    const fetchWithGuard = guardedFetch(guard, inner);
    const res = await fetchWithGuard("https://api.internal:8443/mcp");
    expect(res.status).toBe(200);
    expect(seen).toEqual(["https://api.internal:8443/mcp"]);
  });

  it("blocks undeclared endpoints with NetworkEgressError (VPN-02)", async () => {
    const fetchWithGuard = guardedFetch(guard, inner);
    await expect(fetchWithGuard("https://evil.example.com:8443")).rejects.toThrow(NetworkEgressError);
  });
});

describe("withRetry backoff math", () => {
  it("applies exponential backoff capped at maxDelayMs", async () => {
    const delays: number[] = [];
    const policy = resolveRetryPolicy({
      maxRetries: 3,
      baseDelayMs: 100,
      factor: 10,
      maxDelayMs: 150,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    let calls = 0;
    await expect(
      withRetry(policy, async () => {
        calls++;
        throw new Error("transient");
      }, () => true),
    ).rejects.toThrow("transient");
    expect(calls).toBe(4);
    expect(delays).toEqual([100, 150, 150]);
  });

  it("stops immediately on a non-retryable error", async () => {
    const delays: number[] = [];
    const policy = resolveRetryPolicy({
      maxRetries: 3,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    let calls = 0;
    await expect(
      withRetry(policy, async () => {
        calls++;
        throw new Error("fatal");
      }, () => false),
    ).rejects.toThrow("fatal");
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });
});
