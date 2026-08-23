import { mkdtemp, rm, writeFile, readFile as fsRead } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SandyPluginAPI,
  ToolInputError,
  SessionCache,
  createSandyMcpServer,
  createSandy,
  type PluginSession,
  type SandyPluginOptions,
} from "../src/index.js";

// Wrap createSandy in a spy (delegating to the real one) so the race test can
// count how many times Sandy is actually constructed.
vi.mock("../src/sandy.js", async () => {
  const actual = await vi.importActual<typeof import("../src/sandy.js")>("../src/sandy.js");
  return {
    ...actual,
    createSandy: vi.fn((opts: Parameters<typeof actual.createSandy>[0]) =>
      actual.createSandy(opts),
    ),
  };
});
const createSandyMock = vi.mocked(createSandy);
import { makeInMemoryServer, type TestServer } from "./helpers/mcp.js";

let root: string;
const tmpDirs: string[] = [];
const inMem: TestServer[] = [];

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sandy-plugin-"));
  tmpDirs.push(dir);
  return dir;
}

async function writeConfig(dir: string, allowedPaths: string[]): Promise<string> {
  const manifest = {
    servers: [
      {
        name: "crm",
        transport: "stdio",
        command: ["true"],
        version: "1.0.0",
        capabilities: ["read_deals"],
        allowed_tools: ["read_deals"],
      },
    ],
  };
  const main = {
    mode: "plugin",
    llm: { provider: "host" },
    sandbox: {
      runtime: "custom",
      allowed_paths: allowedPaths,
      allowed_network: [],
      max_memory_mb: 512,
      max_cpu_percent: 25,
    },
    mcp_servers: "./mcp-servers.json",
    report_output_dir: "./reports",
    policy: {
      confirmation_required: ["delete", "overwrite"],
      undo_depth: 5,
      dry_run_default: false,
      audit_payload_logging: false,
      ignore_patterns: [],
    },
  };
  await writeFile(path.join(dir, "mcp-servers.json"), JSON.stringify(manifest, null, 2));
  const cfgPath = path.join(dir, "sandy.json");
  await writeFile(cfgPath, JSON.stringify(main, null, 2));
  return cfgPath;
}

/** Build a live plugin session with an in-memory `crm` MCP server behind it. */
async function makeSession(
  cfgPath: string,
  extra: SandyPluginOptions = {},
): Promise<{ api: SandyPluginAPI; session: PluginSession; close: () => Promise<void> }> {
  const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
  inMem.push(crm);
  // Pin the *detected* sandbox runtime so status/ok are host-independent (a
  // bare host reports "none" and a custom-declared boundary would be reported
  // degraded). A concrete detected runtime ("docker") keeps the report healthy.
  const cache = new SessionCache({
    transportFactory: () => crm.transport,
    detection: () => ({ runtime: "docker" as const, evidence: ["test"] }),
    ...extra,
  });
  const session = await cache.get(cfgPath);
  const api = new SandyPluginAPI(session);
  return {
    api,
    session,
    close: async () => {
      await cache.closeAll();
      await crm.close();
    },
  };
}

beforeAll(async () => {
  root = await tmpWorkspace();
});

afterAll(async () => {
  for (const s of inMem.splice(0)) await s.close();
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("SandyPluginAPI: gather/report (PL-03)", () => {
  it("sandy.gather returns provenance claims, gaps, and progress", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const { api, close } = await makeSession(cfg);
    try {
      const result = await api.gather({
        goal: "deals",
        gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
      });
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]?.source.server).toBe("crm");
      expect(result.claims[0]?.source.argsHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.gaps).toEqual([]);
      expect(result.progress.length).toBeGreaterThan(0);
      expect(result.progress.some((p) => p.startsWith("deals"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("sandy.report renders + writes a confined report and returns it", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const { api, close } = await makeSession(cfg);
    try {
      const result = await api.report({
        goal: "EMEA deals",
        gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
        report: { title: "EMEA", file: "emea.md", summary: "Narrative." },
      });
      expect(result.claims).toHaveLength(1);
      expect(result.reportPath).toBe(path.join(ws, "reports", "emea.md"));
      expect(result.reportContent).toContain("# EMEA");
      const onDisk = await fsRead(path.join(ws, "reports", "emea.md"), "utf8");
      expect(onDisk).toContain("# EMEA");
    } finally {
      await close();
    }
  });

  it("rejects a tool body that violates the schema with a ToolInputError", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const { api, close } = await makeSession(cfg);
    try {
      await expect(api.gather({ goal: "x" })).rejects.toThrow(ToolInputError);
      await expect(api.gather({ goal: "x", gather: [] })).rejects.toThrow(ToolInputError);
      try {
        await api.gather({ goal: "x", gather: [] });
      } catch (err) {
        expect(err).toBeInstanceOf(ToolInputError);
        const e = err as ToolInputError;
        expect(e.tool).toBe("sandy.gather");
        expect(e.issues.length).toBeGreaterThan(0);
      }
    } finally {
      await close();
    }
  });
});

describe("SandyPluginAPI: status (PL-02)", () => {
  it("reports sandbox capability + MCP health", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const { api, close } = await makeSession(cfg);
    try {
      const status = api.status({});
      expect(status.ok).toBe(true);
      expect(status.sandbox.degraded).toBe(false);
      expect(status.mcp.connected).toContain("crm");
      expect(status.mcp.failed).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("SandyPluginAPI: model usage (AU-01, PL-03)", () => {
  it("records host-reported model usage into the audit log and returns a receipt", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const { api, session, close } = await makeSession(cfg);
    try {
      // The engine is the host engine (plugin mode).
      expect(session.sandy.engine.provider).toBe("host");

      const receipt = api.modelUsage({
        provider: "claude-code",
        model: "claude-sonnet",
        inputTokens: 120,
        outputTokens: 34,
        durationMs: 812,
      });
      expect(receipt.recorded).toBe(true);
      expect(receipt.provider).toBe("claude-code");
      expect(receipt.inputTokens).toBe(120);
      expect(receipt.outputTokens).toBe(34);
      expect(receipt.outcome).toBe("ok");
      expect(receipt.seq).toBeGreaterThanOrEqual(1);

      const invocations = session.sandy.audit
        .events()
        .filter((e) => e.type === "model_invocation");
      expect(invocations).toHaveLength(1);
      const data = invocations[0]!.data as Record<string, unknown>;
      expect(data["provider"]).toBe("claude-code");
      expect(data["model"]).toBe("claude-sonnet");
      expect(data["inputTokens"]).toBe(120);
      expect(data["outputTokens"]).toBe(34);
      expect(data["outcome"]).toBe("ok");
      // Default: no payload is logged (AU-02).
      expect(invocations[0]!.payload).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("records an error outcome and rejects a body with no token counts", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const { api, session, close } = await makeSession(cfg);
    try {
      const receipt = api.modelUsage({ error: "context overflow", inputTokens: 10 });
      expect(receipt.outcome).toBe("error");
      const invocations = session.sandy.audit
        .events()
        .filter((e) => e.type === "model_invocation");
      expect((invocations[invocations.length - 1]!.data as Record<string, unknown>)["error"]).toBe(
        "context overflow",
      );

      // A body with no token counts and no error is rejected with a field-level error.
      try {
        api.modelUsage({ provider: "x" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ToolInputError);
      }
    } finally {
      await close();
    }
  });
});

describe("SandyPluginAPI: files (FM, confined)", () => {
  it("writes a new file, reads it back, lists it, renames, and deletes (with confirmation)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const { api, close } = await makeSession(cfg);
    try {
      const w = await api.filesWrite({ path: "notes.md", content: "hello" });
      expect(w.applied).toBe(true);
      expect(w.path).toBe(path.join(ws, "notes.md"));

      const r = await api.filesRead({ path: "notes.md" });
      expect(r.content).toBe("hello");

      const list = await api.filesList({ path: "." });
      expect(list.entries).toContain("notes.md");

      const rn = await api.filesRename({ from: "notes.md", to: "notes2.md", confirmed: true });
      expect(rn.applied).toBe(true);

      // delete is confirmation-gated by the default policy
      const unconfirmed = await api.filesDelete({ path: "notes2.md", kind: "file" });
      expect(unconfirmed.needsConfirmation).toBe(true);
      expect(unconfirmed.applied).toBe(false);

      const del = await api.filesDelete({ path: "notes2.md", kind: "file", confirmed: true });
      expect(del.applied).toBe(true);
    } finally {
      await close();
    }
  });

  it("refuses to touch a path outside the working root (SB-06)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const { api, close } = await makeSession(cfg);
    try {
      const result = await api.filesRead({ path: "../escape.txt" });
      // A sandbox violation is surfaced as a structured error, never thrown to the host.
      expect(result.error).toBeDefined();
      expect(result.error?.reason).toBe("violation");
      expect(result.content).toBeUndefined();
    } finally {
      await close();
    }
  });
});

describe("SessionCache: construction (PL-01)", () => {
  it("get() called concurrently for the same config path returns the same session and builds Sandy only once", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
    inMem.push(crm);
    createSandyMock.mockClear();
    try {
      const cache = new SessionCache({
        transportFactory: () => crm.transport,
        detection: () => ({ runtime: "docker" as const, evidence: ["test"] }),
      });
      const [a, b] = await Promise.all([cache.get(cfg), cache.get(cfg)]);
      expect(a).toBe(b);
      expect(cache.size).toBe(1);
      expect(createSandyMock).toHaveBeenCalledTimes(1);
      await cache.closeAll();
    } finally {
      await crm.close();
    }
  });
});

describe("createSandyMcpServer: MCP surface (PL-01/PL-02)", () => {
  it("exposes the sandy.* tools and answers a call over the MCP protocol", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const { api, close } = await makeSession(cfg);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSandyMcpServer({ api });
    const client = new Client({ name: "test-host", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "sandy.files.delete",
          "sandy.files.list",
          "sandy.files.mkdir",
          "sandy.files.read",
          "sandy.files.rename",
          "sandy.files.write",
          "sandy.gather",
          "sandy.model.usage",
          "sandy.report",
          "sandy.status",
        ].sort(),
      );

      const statusRes = (await client.callTool({ name: "sandy.status", arguments: {} })) as {
        content: Array<{ type: string; text?: string }>;
      };
      const status = JSON.parse((statusRes.content[0] as { text: string }).text) as { ok: boolean };
      expect(status.ok).toBe(true);

      const gatherRes = (await client.callTool({
        name: "sandy.gather",
        arguments: {
          goal: "deals",
          gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
        },
      })) as { content: Array<{ type: string; text?: string }> };
      const gather = JSON.parse((gatherRes.content[0] as { text: string }).text) as {
        claims: unknown[];
        gaps: unknown[];
      };
      expect(gather.claims).toHaveLength(1);
      expect(gather.gaps).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
      await close();
    }
  });
});
