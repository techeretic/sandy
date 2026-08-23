import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InMemoryAuditLogger,
  JsonlAuditLogger,
  McpClientManager,
  NetworkGuard,
  SecretResolver,
  captureTranscript,
  transcriptToMarkdown,
  renderMarkdownReport,
  Orchestrator,
  ReadOnlyGate,
  logWriteAttempt,
  type ProgressEvent,
  type GatherTask,
  type Claim,
  type Gap,
} from "../src/index.js";
import {
  makeInMemoryServer,
  serverConfig,
  instantRetry,
  type TestServer,
} from "./helpers/mcp.js";

const resolver = new SecretResolver({});
const guard = new NetworkGuard([]);

let dir: string;
let servers: TestServer[] = [];

async function withManager<T>(
  setup: (configs: Array<ReturnType<typeof serverConfig>>, servers: TestServer[]) => Promise<McpClientManager>,
  fn: (manager: McpClientManager) => Promise<T>,
): Promise<T> {
  const configs = [serverConfig("crm", ["read_deals"]), serverConfig("jira", ["read_issues"])];
  const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
  const jira = await makeInMemoryServer("jira", [{ name: "read_issues" }]);
  servers = [crm, jira];
  const manager = await setup(configs, servers);
  try {
    return await fn(manager);
  } finally {
    await manager.close();
    for (const s of servers) await s.close();
    servers = [];
  }
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sandy-orch-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Orchestrator: fan-out (RG-01)", () => {
  it("gathers from multiple servers in one request", async () => {
    await withManager(
      async (configs, svcs) => {
        const [crm, jira] = [svcs[0] as TestServer, svcs[1] as TestServer];
        const manager = new McpClientManager(
          configs,
          resolver,
          guard,
          { retry: instantRetry, transportFactory: (c) => (c.name === "crm" ? crm.transport : jira.transport) },
        );
        await manager.connectAll();
        return manager;
      },
      async (manager) => {
        const audit = new InMemoryAuditLogger();
        const orch = new Orchestrator({ manager, audit, concurrency: 5 });
        const result = await orch.run({
          goal: "deal + issue summary",
          gather: [
            { id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } },
            { id: "issues", server: "jira", tool: "read_issues", args: { sprint: 42 } },
          ],
        });
        expect(result.claims).toHaveLength(2);
        expect(result.claims.map((c) => c.source.task).sort()).toEqual(["deals", "issues"]);
        expect(result.gaps).toEqual([]);
      },
    );
  });

  it("respects the concurrency bound", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Stub manager: the Orchestrator only uses callTool + failedServers.
    const stub = {
      failedServers: [] as Array<{ server: string; error: string }>,
      async callTool(_server: string, _tool: string, _args: Record<string, unknown>): Promise<unknown> {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await sleep(20);
          return { content: [{ type: "text", text: "ok" }] };
        } finally {
          inFlight--;
        }
      },
    } as unknown as McpClientManager;

    const audit = new InMemoryAuditLogger();
    const orch = new Orchestrator({ manager: stub, audit, concurrency: 2 });
    const result = await orch.run({
      goal: "concurrency check",
      gather: [0, 1, 2, 3, 4].map((i) => ({ id: `t${i}`, server: `s${i}`, tool: `t${i}`, args: {} })),
    });
    expect(result.claims).toHaveLength(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });
});

describe("Orchestrator: provenance (RG-04)", () => {
  it("every claim carries a resolvable source reference", async () => {
    await withManager(
      async (configs, svcs) => {
        const crm = svcs[0] as TestServer;
        const manager = new McpClientManager(
          configs,
          resolver,
          guard,
          { retry: instantRetry, transportFactory: (c) => (c.name === "crm" ? crm.transport : ({} as never)) },
        );
        await manager.connectAll();
        return manager;
      },
      async (manager) => {
        const orch = new Orchestrator({ manager, audit: new InMemoryAuditLogger() });
        const result = await orch.run({
          goal: "deals",
          gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
        });
        const claim = result.claims[0] as Claim;
        expect(claim.ref).toBe(1);
        expect(claim.source.server).toBe("crm");
        expect(claim.source.tool).toBe("read_deals");
        expect(claim.source.argsHash).toMatch(/^[a-f0-9]{64}$/);
        expect(claim.source.at).toBeTruthy();
      },
    );
  });
});

describe("Orchestrator: gaps (RG-05/06)", () => {
  it("reports a failing tool as an explicit gap, and never fabricates a claim", async () => {
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals", fail: true }]);
    const jira = await makeInMemoryServer("jira", [{ name: "read_issues" }]);
    servers = [crm, jira];
    const manager = new McpClientManager(
      [serverConfig("crm", ["read_deals"]), serverConfig("jira", ["read_issues"])],
      resolver,
      guard,
      { retry: instantRetry, transportFactory: (c) => (c.name === "crm" ? crm.transport : jira.transport) },
    );
    await manager.connectAll();
    const orch = new Orchestrator({ manager, audit: new InMemoryAuditLogger() });
    const result = await orch.run({
      goal: "mixed",
      gather: [
        { id: "deals", server: "crm", tool: "read_deals", args: {} },
        { id: "issues", server: "jira", tool: "read_issues", args: {} },
      ],
    });
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.source.task).toBe("issues");
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.task).toBe("deals");
    expect(result.gaps[0]?.reason).toBe("call-failed");

    await manager.close();
    for (const s of servers) await s.close();
    servers = [];
  });

  it("reports a startup-failed server as a gap for tasks that targeted it", async () => {
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
    servers = [crm];
    const manager = new McpClientManager(
      [serverConfig("crm", ["read_deals"]), serverConfig("jira", ["read_issues"])],
      resolver,
      guard,
      {
        retry: instantRetry,
        transportFactory: (c) => {
          if (c.name === "jira") {
            return {
              start: async () => {
                throw new Error("connect ECONNREFUSED");
              },
              send: async () => {
                throw new Error("closed");
              },
              close: async () => {},
            };
          }
          return crm.transport;
        },
      },
    );
    const result0 = await manager.connectAll();
    expect(result0.failed.map((f) => f.server)).toEqual(["jira"]);

    const orch = new Orchestrator({ manager, audit: new InMemoryAuditLogger() });
    const result = await orch.run({
      goal: "both",
      gather: [
        { id: "deals", server: "crm", tool: "read_deals", args: {} },
        { id: "issues", server: "jira", tool: "read_issues", args: {} },
      ],
    });
    const jiraGap = result.gaps.find((g) => g.task === "issues");
    expect(jiraGap).toBeDefined();
    expect(jiraGap?.reason).toBe("server-unavailable");

    await manager.close();
    for (const s of servers) await s.close();
    servers = [];
  });

  it("emits a gap for an empty (no-text) result", async () => {
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals", respond: () => "" }]);
    servers = [crm];
    const manager = new McpClientManager(
      [serverConfig("crm", ["read_deals"])],
      resolver,
      guard,
      { retry: instantRetry, transportFactory: () => crm.transport },
    );
    await manager.connectAll();
    const orch = new Orchestrator({ manager, audit: new InMemoryAuditLogger() });
    const result = await orch.run({
      goal: "empty",
      gather: [{ id: "deals", server: "crm", tool: "read_deals", args: {} }],
    });
    expect(result.claims).toEqual([]);
    expect(result.gaps[0]?.reason).toBe("empty-result");

    await manager.close();
    for (const s of servers) await s.close();
    servers = [];
  });
});

describe("Orchestrator: progress (Q4)", () => {
  it("emits task-started, task-succeeded, and done events", async () => {
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
    servers = [crm];
    const manager = new McpClientManager(
      [serverConfig("crm", ["read_deals"])],
      resolver,
      guard,
      { retry: instantRetry, transportFactory: () => crm.transport },
    );
    await manager.connectAll();
    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({ manager, audit: new InMemoryAuditLogger(), onProgress: (e) => events.push(e) });
    await orch.run({
      goal: "progress",
      gather: [{ id: "deals", server: "crm", tool: "read_deals", args: {} }],
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("task-started");
    expect(types).toContain("task-succeeded");
    expect(types).toContain("done");

    await manager.close();
    for (const s of servers) await s.close();
    servers = [];
  });
});

describe("Report rendering (RG-02/04/05)", () => {
  const claims: Claim[] = [
    {
      ref: 1,
      text: "3 deals closed in EMEA this quarter.",
      source: { task: "deals", server: "crm", tool: "read_deals", argsHash: "abc123", at: "2026-08-17T00:00:00Z" },
    },
  ];
  const gaps: Gap[] = [
    { task: "issues", server: "jira", tool: "read_issues", reason: "call-failed", detail: "boom" },
  ];

  it("renders claims with footnotes and a provenance table", () => {
    const md = renderMarkdownReport({
      goal: "q",
      title: "Q",
      claims,
      gaps,
      generatedAt: "2026-08-17T00:00:00Z",
    });
    expect(md).toContain("3 deals closed in EMEA this quarter.");
    expect(md).toContain("[^1]");
    expect(md).toContain("`crm`");
    expect(md).toContain("`read_deals`");
    expect(md).toContain("abc123");
  });

  it("renders an explicit Gaps section", () => {
    const md = renderMarkdownReport({ goal: "q", title: "Q", claims, gaps, generatedAt: "x" });
    expect(md).toContain("## Gaps");
    expect(md).toContain("jira/read_issues");
    expect(md).toContain("call failed");
  });

  it("says the data was unavailable when there are no claims, not filler", () => {
    const md = renderMarkdownReport({
      goal: "q",
      title: "Q",
      claims: [],
      gaps: [{ task: "t", server: "s", tool: "t", reason: "call-failed", detail: "x" }],
      generatedAt: "x",
    });
    expect(md).toContain("No data could be retrieved");
    expect(md).toContain("## Gaps");
  });
});

describe("Write gate (Q6)", () => {
  it("ReadOnlyGate refuses every write", () => {
    const gate = new ReadOnlyGate();
    const decision = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("gate-refused");
  });

  it("logs a write attempt + decision to the audit trail", () => {
    const audit = new InMemoryAuditLogger();
    logWriteAttempt(audit, { id: "w1", server: "crm", tool: "write_deal", args: {} }, { allowed: false, reason: "gate-refused" });
    const events = audit.events();
    expect(events[events.length - 1]?.type).toBe("write_attempt");
    const data = events[events.length - 1]?.data as Record<string, unknown>;
    expect(data.allowed).toBe(false);
    expect(data.reason).toBe("gate-refused");
  });
});

describe("Audit logging (AU-01/02/03)", () => {
  it("records MCP calls and file mutations via the bridges", async () => {
    const audit = new InMemoryAuditLogger();
    const { mcpAuditSink, fileAuditSink } = await import("../src/index.js");
    mcpAuditSink(audit).record({
      server: "crm",
      tool: "read_deals",
      argsHash: "h",
      at: "2026-08-17T00:00:00Z",
      durationMs: 5,
      outcome: "ok",
    });
    fileAuditSink(audit).record({ op: "write", path: "/x", at: "t", outcome: "ok" });
    const types = audit.events().map((e) => e.type);
    expect(types).toContain("mcp_call");
    expect(types).toContain("file_mutation");
  });

  it("keeps payloads out of the log unless opted in (AU-02)", () => {
    const off = new InMemoryAuditLogger({ auditPayloadLogging: false });
    off.append("model_invocation", { provider: "host" }, { payload: "top-secret-prompt" });
    expect(JSON.stringify(off.events())).not.toContain("top-secret-prompt");

    const on = new InMemoryAuditLogger({ auditPayloadLogging: true });
    on.append("model_invocation", { provider: "host" }, { payload: "top-secret-prompt" });
    expect(JSON.stringify(on.events())).toContain("top-secret-prompt");
  });

  it("JsonlAuditLogger writes ordered, one-object-per-line JSON", async () => {
    const file = path.join(dir, "audit.log");
    const logger = new JsonlAuditLogger(file);
    logger.append("session_start", { goal: "g" });
    logger.append("mcp_call", { server: "crm", tool: "read_deals" });
    logger.append("session_end", { claims: 1 });
    await logger.close();

    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l) as { seq: number; type: string });
    expect(parsed.map((p) => p.seq)).toEqual([1, 2, 3]);
    expect(parsed.map((p) => p.type)).toEqual(["session_start", "mcp_call", "session_end"]);
  });

  it("close() rejects if a JSONL write ever failed during the session", async () => {
    // Make the write fail reliably: put a *file* at the parent path, so the
    // logger's mkdir(path.dirname(filePath)) fails with ENOTDIR. (Permission
    // tricks behave inconsistently across CI runners and are meaningless as
    // root.)
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    try {
      const logger = new JsonlAuditLogger(path.join(blocker, "audit.jsonl"));
      logger.append("session_start", {});
      await expect(logger.close()).rejects.toThrow();
    } finally {
      await rm(blocker);
    }
  });

  it("keeps appending in-memory events after a failed disk write (and reports the first error at close)", async () => {
    const blocker = path.join(dir, "blocker2");
    await writeFile(blocker, "not a directory");
    try {
      const logger = new JsonlAuditLogger(path.join(blocker, "audit.jsonl"));
      logger.append("session_start", {});
      // The write fails asynchronously; append() itself must stay usable and
      // must not surface an unhandled rejection.
      const ev2 = logger.append("mcp_call", { server: "crm", tool: "read_deals" });
      expect(ev2.seq).toBe(2);
      expect(logger.events()).toHaveLength(2);
      await expect(logger.close()).rejects.toThrow(/EEXIST|ENOENT|ENOTDIR|not a directory|failed/i);
    } finally {
      await rm(blocker);
    }
  });

  it("captures a session transcript (AU-03)", () => {
    const audit = new InMemoryAuditLogger();
    audit.append("session_start", { goal: "g", tasks: 1 });
    audit.append("mcp_call", { server: "crm", tool: "read_deals", outcome: "ok" });
    const transcript = captureTranscript(audit);
    expect(transcript.count).toBe(2);
    const md = transcriptToMarkdown(transcript);
    expect(md).toContain("# Session transcript");
    expect(md).toContain("crm/read_deals");
  });
});

describe("Orchestrator: end-to-end with report writing", () => {
  it("runs a request, renders, and writes a report to the confined dir", async () => {
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
    servers = [crm];
    const manager = new McpClientManager(
      [serverConfig("crm", ["read_deals"])],
      resolver,
      guard,
      { retry: instantRetry, transportFactory: () => crm.transport },
    );
    await manager.connectAll();

    const audit = new InMemoryAuditLogger();
    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      manager,
      audit,
      onProgress: (e) => events.push(e),
      writeReport: async (content, file) => {
        const { writeFile } = await import("node:fs/promises");
        const abs = path.join(dir, file);
        await writeFile(abs, content);
        return abs;
      },
    });

    const result = await orch.run({
      goal: "deals report",
      gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
      report: { title: "EMEA Deals", file: "emea.md" },
    });

    expect(result.reportContent).toContain("# EMEA Deals");
    expect(result.reportPath).toBe(path.join(dir, "emea.md"));
    expect(await readFile(path.join(dir, "emea.md"), "utf8")).toContain("# EMEA Deals");
    expect(events.some((e) => e.type === "report-writing")).toBe(true);

    await manager.close();
    for (const s of servers) await s.close();
    servers = [];
  });

  it("run() returns already-gathered claims/gaps even if the report write fails", async () => {
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
    servers = [crm];
    const manager = new McpClientManager(
      [serverConfig("crm", ["read_deals"])],
      resolver,
      guard,
      { retry: instantRetry, transportFactory: () => crm.transport },
    );
    await manager.connectAll();

    const audit = new InMemoryAuditLogger();
    const orch = new Orchestrator({
      manager,
      audit,
      writeReport: async (_content, _file) => {
        // Stand in for the real failure: a non-markdown extension makes
        // FileManager.write()'s format validation reject the report content.
        throw new Error('file operation failed (format-invalid): not valid Markdown');
      },
    });

    const result = await orch.run({
      goal: "deals report",
      gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
      report: { title: "EMEA Deals", file: "summary.json" },
    });

    // The gathered data must survive the write failure, not be discarded.
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.reportPath).toBeUndefined();
    expect(result.reportError).toBeDefined();
    expect(result.reportError).toMatch(/format-invalid/);
    // The rendered content is still available to the caller.
    expect(result.reportContent).toContain("# EMEA Deals");
    // The failure is audited, not lost.
    const writeFail = audit
      .events()
      .filter((e) => e.type === "orchestrator_task" && e.data["task"] === "report-write");
    expect(writeFail).toHaveLength(1);
    expect(writeFail[0]!.data["outcome"]).toBe("error");

    await manager.close();
    for (const s of servers) await s.close();
    servers = [];
  });
});
