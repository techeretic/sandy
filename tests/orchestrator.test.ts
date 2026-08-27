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
  callSignature,
  captureTranscript,
  transcriptToMarkdown,
  renderMarkdownReport,
  renderReport,
  renderHtmlReport,
  reportFormatExtension,
  REPORT_FORMATS,
  Orchestrator,
  PolicyApprovalGate,
  ReadOnlyGate,
  logWriteAttempt,
  createOrchestrator,
  FileManager,
  PathConfinement,
  type ProgressEvent,
  type GatherTask,
  type Claim,
  type Gap,
  type WriteTask,
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

describe("callSignature (issue #19: re-gather de-duplication)", () => {
  it("identifies the same call regardless of arg key order", () => {
    expect(callSignature("crm", "read_deals", { region: "emea", limit: 10 })).toBe(
      callSignature("crm", "read_deals", { limit: 10, region: "emea" }),
    );
  });

  it("distinguishes different tools, servers, and args", () => {
    const a = callSignature("crm", "read_deals", { region: "emea" });
    expect(callSignature("crm", "read_contacts", { region: "emea" })).not.toBe(a);
    expect(callSignature("jira", "read_deals", { region: "emea" })).not.toBe(a);
    expect(callSignature("crm", "read_deals", { region: "apac" })).not.toBe(a);
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

describe("Report formats (issue #14): claims/provenance survive the transform", () => {
  // A claim whose text needs escaping plus a gap, so both the provenance
  // table and the explicit-holes section are exercised in every format.
  const claims: Claim[] = [
    {
      ref: 1,
      text: "3 deals closed in EMEA <this & that>",
      source: { task: "deals", server: "crm", tool: "read_deals", argsHash: "abc123", at: "2026-08-17T00:00:00Z" },
    },
  ];
  const gaps: Gap[] = [
    { task: "issues", server: "jira", tool: "read_issues", reason: "call-failed", detail: "boom" },
  ];
  const input = { goal: "quarterly", title: "Quarterly <Q>", claims, gaps, generatedAt: "2026-08-17T00:00:00Z" };

  it("markdown keeps every claim, gap, and provenance entry (source of truth)", () => {
    const md = renderMarkdownReport(input);
    expect(md).toContain("3 deals closed in EMEA <this & that>");
    expect(md).toContain("jira/read_issues");
    expect(md).toContain("call failed");
    expect(md).toContain("`crm`");
    expect(md).toContain("`read_deals`");
    expect(md).toContain("abc123");
  });

  it("html keeps every claim, gap, and provenance entry (same content, new presentation)", () => {
    const html = renderHtmlReport(input);
    expect(html).toContain("<!DOCTYPE html>");
    // Claim text is preserved but escaped for the HTML context.
    expect(html).toContain("3 deals closed in EMEA &lt;this &amp; that&gt;");
    expect(html).not.toContain("<this & that>");
    // The provenance table carries the same source data.
    expect(html).toContain("crm");
    expect(html).toContain("read_deals");
    expect(html).toContain("abc123");
    // Gaps are explicit, never smoothed over.
    expect(html).toContain("jira/read_issues");
    expect(html).toContain("call failed");
    expect(html).toContain("boom");
    // The title is escaped too.
    expect(html).toContain("Quarterly &lt;Q&gt;");
  });

  it("renderReport dispatches to the right renderer per format", () => {
    expect(renderReport("markdown", input)).toBe(renderMarkdownReport(input));
    expect(renderReport("html", input)).toBe(renderHtmlReport(input));
  });

  it("reportFormatExtension maps each supported format to its file extension", () => {
    expect(reportFormatExtension("markdown")).toBe(".md");
    expect(reportFormatExtension("html")).toBe(".html");
    // The dispatcher only knows the implemented formats.
    expect(REPORT_FORMATS).toEqual(["markdown", "html"]);
  });
});

describe("Write gate (Q6)", () => {
  it("ReadOnlyGate refuses every write, even with an approval", () => {
    const gate = new ReadOnlyGate();
    const decision = gate.decide(
      { id: "w1", server: "crm", tool: "write_deal", args: {} },
      { taskId: "w1", approver: "alice", reason: "ok" },
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("gate-refused");
  });

  it("PolicyApprovalGate refuses a target not on the write allowlist (not-allowed-by-policy)", () => {
    const gate = new PolicyApprovalGate({ allowlist: [{ server: "crm", tool: "write_deal" }] });
    const d1 = gate.decide({ id: "w1", server: "crm", tool: "delete_deal", args: {} });
    expect(d1).toEqual({ allowed: false, reason: "not-allowed-by-policy" });
    // A read-allowed tool that is not on the (stricter) write allowlist is also refused.
    const d2 = gate.decide({ id: "w2", server: "crm", tool: "read_deals", args: {} });
    expect(d2).toEqual({ allowed: false, reason: "not-allowed-by-policy" });
    // An unknown server is refused.
    const d3 = gate.decide({ id: "w3", server: "erp", tool: "write_deal", args: {} });
    expect(d3).toEqual({ allowed: false, reason: "not-allowed-by-policy" });
  });

  it("PolicyApprovalGate refuses an allowlisted write without an approval (no-approval)", () => {
    const gate = new PolicyApprovalGate({ allowlist: [{ server: "crm", tool: "write_deal" }] });
    const decision = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: { id: 1 } });
    expect(decision).toEqual({ allowed: false, reason: "no-approval" });
  });

  it("PolicyApprovalGate allows an allowlisted write with a matching approval, and carries it on the decision", () => {
    const gate = new PolicyApprovalGate({ allowlist: [{ server: "crm", tool: "write_deal" }] });
    const approval = { taskId: "w1", approver: "alice", reason: "user confirmed" };
    expect(gate.approve(approval)).toBe(true);
    const decision = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: { id: 1 } }, approval);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.approval).toEqual(approval);
  });

  it("PolicyApprovalGate approvals are single-use: a consumed approval cannot be replayed", () => {
    const gate = new PolicyApprovalGate({ allowlist: [{ server: "crm", tool: "write_deal" }] });
    const approval = { taskId: "w1", approver: "alice", reason: "user confirmed" };
    gate.approve(approval);
    const first = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval);
    expect(first.allowed).toBe(true);
    // The same approval object, replayed onto the same task: refused.
    const second = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval);
    expect(second).toEqual({ allowed: false, reason: "no-approval" });
  });

  it("PolicyApprovalGate refuses an approval bound to a different task", () => {
    const gate = new PolicyApprovalGate({ allowlist: [{ server: "crm", tool: "write_deal" }] });
    const approval = { taskId: "other", approver: "alice", reason: "user confirmed" };
    gate.approve(approval);
    const decision = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval);
    expect(decision).toEqual({ allowed: false, reason: "no-approval" });
  });

  it("PolicyApprovalGate refuses a duplicate approval registration (no standing blanket consent)", () => {
    const gate = new PolicyApprovalGate({ allowlist: [{ server: "crm", tool: "write_deal" }] });
    const approval = { taskId: "w1", approver: "alice", reason: "user confirmed" };
    expect(gate.approve(approval)).toBe(true);
    expect(gate.approve(approval)).toBe(false);
    // The first registration is still the only valid one.
    const decision = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval);
    expect(decision.allowed).toBe(true);
  });

  it("an empty allowlist refuses everything (fail-closed default posture)", () => {
    const gate = new PolicyApprovalGate({ allowlist: [] });
    const approval = { taskId: "w1", approver: "alice", reason: "ok" };
    gate.approve(approval);
    const decision = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval);
    expect(decision).toEqual({ allowed: false, reason: "not-allowed-by-policy" });
  });

  it("PolicyApprovalGate (v2) allows args that satisfy the entry's per-arg constraints", () => {
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal", args: { region: { enum: ["emea", "apac"] } } }],
    });
    const approval = { taskId: "w1", approver: "alice", reason: "ok" };
    gate.approve(approval);
    const decision = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: { region: "emea" } }, approval);
    expect(decision.allowed).toBe(true);
  });

  it("PolicyApprovalGate (v2) refuses args outside the entry's constraints (args-not-allowed)", () => {
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal", args: { region: { enum: ["emea"] } } }],
    });
    const approval = { taskId: "w1", approver: "alice", reason: "ok" };
    gate.approve(approval);
    const decision = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: { region: "latam" } }, approval);
    expect(decision).toEqual({ allowed: false, reason: "args-not-allowed" });
  });

  it("PolicyApprovalGate (v2) refuses args missing a constrained key (a constraint is a promise about the value)", () => {
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal", args: { region: { enum: ["emea"] } } }],
    });
    const approval = { taskId: "w1", approver: "alice", reason: "ok" };
    gate.approve(approval);
    const decision = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval);
    expect(decision).toEqual({ allowed: false, reason: "args-not-allowed" });
  });

  it("PolicyApprovalGate (v2) lets args carry keys beyond the constraints (pins values, does not enumerate)", () => {
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal", args: { region: { enum: ["emea"] } } }],
    });
    const approval = { taskId: "w1", approver: "alice", reason: "ok" };
    gate.approve(approval);
    const decision = gate.decide(
      { id: "w1", server: "crm", tool: "write_deal", args: { region: "emea", note: "extra key is fine" } },
      approval,
    );
    expect(decision.allowed).toBe(true);
  });

  it("PolicyApprovalGate (v2) with no constraints accepts any args (the v1 behavior)", () => {
    const gate = new PolicyApprovalGate({ allowlist: [{ server: "crm", tool: "write_deal" }] });
    const approval = { taskId: "w1", approver: "alice", reason: "ok" };
    gate.approve(approval);
    const decision = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: { anything: "goes" } }, approval);
    expect(decision.allowed).toBe(true);
  });

  it("PolicyApprovalGate (v2) fails closed on an invalid constraint fragment (never a silent pass)", () => {
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal", args: { region: { notARealKeyword: true } } }],
    });
    const approval = { taskId: "w1", approver: "alice", reason: "ok" };
    gate.approve(approval);
    const decision = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: { region: "emea" } }, approval);
    expect(decision).toEqual({ allowed: false, reason: "args-not-allowed" });
  });

  it("PolicyApprovalGate (v2) allowlist() reports per-arg constraints in configuration order", () => {
    const gate = new PolicyApprovalGate({
      allowlist: [
        { server: "crm", tool: "write_deal", args: { region: { enum: ["emea"] } } },
        { server: "crm", tool: "read_deals" },
      ],
    });
    expect(gate.allowlist()).toEqual([
      { server: "crm", tool: "write_deal", args: { region: { enum: ["emea"] } } },
      { server: "crm", tool: "read_deals" },
    ]);
  });

  it("PolicyApprovalGate (v2) expires an approval after the default TTL (clock-seamed)", () => {
    let now = 1_000_000;
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal" }],
      approvalTtlSeconds: 10,
      now: () => now,
    });
    const approval = { taskId: "w1", approver: "alice", reason: "ok" };
    gate.approve(approval);
    // Within the window: allowed.
    expect(gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval).allowed).toBe(true);
    // Past the window: expired, with its own audited reason.
    const gate2 = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal" }],
      approvalTtlSeconds: 10,
      now: () => now,
    });
    gate2.approve(approval);
    now += 11_000;
    expect(gate2.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval)).toEqual({
      allowed: false,
      reason: "approval-expired",
    });
  });

  it("PolicyApprovalGate (v2) honors an explicit expiresAt that SHORTENS the default window", () => {
    let now = 1_000_000;
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal" }],
      approvalTtlSeconds: 3600,
      now: () => now,
    });
    // An explicit expiry 1s out, within a 1h default window.
    const approval = { taskId: "w1", approver: "alice", reason: "ok", expiresAt: new Date(now + 1000).toISOString() };
    gate.approve(approval);
    now += 2000; // past the 1s explicit expiry (still inside the 1h default)
    expect(gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval)).toEqual({
      allowed: false,
      reason: "approval-expired",
    });
  });

  it("PolicyApprovalGate (v2) lets expiresAt extend NO further than the default TTL (tighten-never-loosen)", () => {
    let now = 1_000_000;
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal" }],
      approvalTtlSeconds: 10,
      now: () => now,
    });
    // An explicit expiry far in the future is clamped to the default 10s window.
    const approval = { taskId: "w1", approver: "alice", reason: "ok", expiresAt: new Date(now + 3_600_000).toISOString() };
    gate.approve(approval);
    now += 11_000; // past the clamped 10s (not the 1h the approval asked for)
    expect(gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval)).toEqual({
      allowed: false,
      reason: "approval-expired",
    });
  });

  it("PolicyApprovalGate (v2) treats an unparseable expiresAt as the default TTL (fail closed, not extended)", () => {
    let now = 1_000_000;
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal" }],
      approvalTtlSeconds: 10,
      now: () => now,
    });
    const approval = { taskId: "w1", approver: "alice", reason: "ok", expiresAt: "not-a-date" };
    gate.approve(approval);
    now += 11_000;
    expect(gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval)).toEqual({
      allowed: false,
      reason: "approval-expired",
    });
  });

  it("PolicyApprovalGate (v2) resolves a pending approval with NO inline approval (the consent flow)", () => {
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal" }],
      approvalTtlSeconds: 60,
      now: () => 1_000_000,
    });
    const approval = { taskId: "w1", approver: "alice", reason: "consent recorded out-of-band" };
    expect(gate.approve(approval)).toBe(true);
    // decide() with no inline approval still proceeds on the recorded consent.
    const decision = gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.approval).toEqual(approval);
    // Single-use: a second decide with no new consent is refused.
    expect(gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} })).toEqual({
      allowed: false,
      reason: "no-approval",
    });
  });

  it("PolicyApprovalGate (v2) revokes a pending approval; the write is then refused approval-revoked", () => {
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal" }],
      approvalTtlSeconds: 60,
      now: () => 1_000_000,
    });
    const approval = { taskId: "w1", approver: "alice", reason: "ok" };
    gate.approve(approval);
    expect(gate.revoke("w1")).toBe(1);
    // The recorded consent is gone: a decide with no inline approval is no-approval.
    expect(gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} })).toEqual({
      allowed: false,
      reason: "no-approval",
    });
    // Re-presenting the (now revoked) approval inline is refused approval-revoked.
    expect(gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval)).toEqual({
      allowed: false,
      reason: "approval-revoked",
    });
    // And it can never be re-registered.
    expect(gate.approve(approval)).toBe(false);
  });

  it("PolicyApprovalGate (v2) revokes only the named approver when approver is given", () => {
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal" }],
      approvalTtlSeconds: 60,
      now: () => 1_000_000,
    });
    const alice = { taskId: "w1", approver: "alice", reason: "ok" };
    const bob = { taskId: "w1", approver: "bob", reason: "ok" };
    gate.approve(alice);
    gate.approve(bob);
    // Revoke only alice's consent; bob's stands.
    expect(gate.revoke("w1", "alice")).toBe(1);
    expect(gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, alice)).toEqual({
      allowed: false,
      reason: "approval-revoked",
    });
    expect(gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, bob).allowed).toBe(true);
  });

  it("PolicyApprovalGate (v2) revoke of nothing is a no-op (0), not an error", () => {
    const gate = new PolicyApprovalGate({ allowlist: [{ server: "crm", tool: "write_deal" }] });
    expect(gate.revoke("w1")).toBe(0);
    expect(gate.revoke("w1", "alice")).toBe(0);
  });

  it("PolicyApprovalGate (v2) treats (taskId, approver) as a durable identity: re-consent needs a fresh task id", () => {
    let now = 1_000_000;
    const gate = new PolicyApprovalGate({
      allowlist: [{ server: "crm", tool: "write_deal" }],
      approvalTtlSeconds: 10,
      now: () => now,
    });
    const approval = { taskId: "w1", approver: "alice", reason: "ok" };
    gate.approve(approval);
    // Let the consent expire.
    now += 11_000;
    expect(gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval)).toEqual({
      allowed: false,
      reason: "approval-expired",
    });
    // The (w1, alice) pair is now durable: re-presenting and re-registering are both refused.
    expect(gate.decide({ id: "w1", server: "crm", tool: "write_deal", args: {} }, approval)).toEqual({
      allowed: false,
      reason: "approval-expired",
    });
    expect(gate.approve(approval)).toBe(false);
    // Re-consent for the SAME write opens a NEW window under a fresh task id.
    const fresh = { taskId: "w1-retry", approver: "alice", reason: "ok" };
    expect(gate.approve(fresh)).toBe(true);
    expect(gate.decide({ id: "w1-retry", server: "crm", tool: "write_deal", args: {} }, fresh).allowed).toBe(true);
  });

  it("logs a write attempt + decision to the audit trail (refused and allowed)", () => {
    const audit = new InMemoryAuditLogger();
    logWriteAttempt(audit, { id: "w1", server: "crm", tool: "write_deal", args: {} }, { allowed: false, reason: "gate-refused" });
    logWriteAttempt(
      audit,
      { id: "w2", server: "crm", tool: "write_deal", args: {} },
      { allowed: true, approval: { taskId: "w2", approver: "alice", reason: "ok" } },
    );
    const events = audit.events();
    const refused = events[events.length - 2];
    expect(refused?.type).toBe("write_attempt");
    const refusedData = refused?.data as Record<string, unknown>;
    expect(refusedData.allowed).toBe(false);
    expect(refusedData.reason).toBe("gate-refused");
    const allowed = events[events.length - 1];
    const allowedData = allowed?.data as Record<string, unknown>;
    expect(allowed?.type).toBe("write_attempt");
    expect(allowedData.allowed).toBe(true);
    expect(allowedData.approver).toBe("alice");
    expect(allowedData.approval_reason).toBe("ok");
  });
});

describe("Orchestrator: write-back (Q6)", () => {
  const crmWrite = { id: "w1", server: "crm", tool: "write_deal", args: { region: "emea" } } satisfies WriteTask;

  async function withWriteManager<T>(
    writeTools: string[],
    fn: (manager: McpClientManager, crm: TestServer) => Promise<T>,
  ): Promise<T> {
    const configs = [
      serverConfig("crm", ["read_deals", ...writeTools]),
      serverConfig("jira", ["read_issues"]),
    ];
    const crm = await makeInMemoryServer("crm", [
      { name: "read_deals" },
      ...writeTools.map((name) => ({ name })),
    ]);
    const jira = await makeInMemoryServer("jira", [{ name: "read_issues" }]);
    const manager = new McpClientManager(configs, resolver, guard, {
      retry: instantRetry,
      transportFactory: (c) => (c.name === "crm" ? crm.transport : jira.transport),
    });
    await manager.connectAll();
    try {
      return await fn(manager, crm);
    } finally {
      await manager.close();
      await crm.close();
      await jira.close();
    }
  }

  it("refuses every write by default (ReadOnlyGate, fail closed)", async () => {
    await withWriteManager(["write_deal"], async (manager, crm) => {
      const audit = new InMemoryAuditLogger();
      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({ manager, audit, onProgress: (e) => events.push(e) });
      const results = await orch.write([crmWrite]);
      expect(results).toEqual([
        { task: "w1", server: "crm", tool: "write_deal", allowed: false, reason: "gate-refused" },
      ]);
      expect(crm.calls.get("write_deal")).toBeUndefined();
      const writeEvents = audit.events().filter((e) => e.type === "write_attempt");
      expect(writeEvents).toHaveLength(1);
      expect(writeEvents[0]!.data).toMatchObject({ allowed: false, reason: "gate-refused" });
      expect(events.some((e) => e.type === "write-denied")).toBe(true);
    });
  });

  it("executes an approved, allowlisted write and returns the server result", async () => {
    await withWriteManager(["write_deal"], async (manager, crm) => {
      const audit = new InMemoryAuditLogger();
      const events: ProgressEvent[] = [];
      const gate = new PolicyApprovalGate({ allowlist: [{ server: "crm", tool: "write_deal" }] });
      const approval = { taskId: "w1", approver: "alice", reason: "user confirmed" };
      gate.approve(approval);
      const orch = new Orchestrator({ manager, audit, writeGate: gate, onProgress: (e) => events.push(e) });

      const results = await orch.write([crmWrite], { w1: approval });

      expect(results).toHaveLength(1);
      expect(results[0]!.allowed).toBe(true);
      expect(results[0]!.error).toBeUndefined();
      // The call actually reached the server, with the task's args.
      expect(crm.calls.get("write_deal")).toBe(1);
      expect(crm.lastArgs.get("write_deal")).toEqual({ region: "emea" });
      // The approval is single-use: the same approval no longer works.
      const replay = await orch.write([crmWrite], { w1: approval });
      expect(replay[0]!.allowed).toBe(false);
      if (replay[0]!.allowed === false) expect(replay[0]!.reason).toBe("no-approval");
      expect(crm.calls.get("write_deal")).toBe(1);
      // Progress events surfaced the approval and the execution.
      expect(events.some((e) => e.type === "write-approved" && (e as { approver?: string }).approver === "alice")).toBe(true);
      expect(events.some((e) => e.type === "write-succeeded")).toBe(true);
      // Both decisions are audited, with the approval on the allowed one.
      const writeEvents = audit.events().filter((e) => e.type === "write_attempt");
      expect(writeEvents.map((e) => e.data["allowed"])).toEqual([true, false]);
      expect(writeEvents[0]!.data["approver"]).toBe("alice");
    });
  });

  it("refuses a write whose target is not on the allowlist, before anything hits the wire", async () => {
    await withWriteManager(["write_deal"], async (manager, crm) => {
      const audit = new InMemoryAuditLogger();
      const gate = new PolicyApprovalGate({ allowlist: [{ server: "crm", tool: "write_deal" }] });
      const orch = new Orchestrator({ manager, audit, writeGate: gate });
      const results = await orch.write([
        { id: "w1", server: "crm", tool: "read_deals", args: {} },
      ]);
      expect(results[0]).toMatchObject({ allowed: false, reason: "not-allowed-by-policy" });
      expect(crm.calls.get("read_deals")).toBeUndefined();
    });
  });

  it("refuses an allowlisted write when no approval is presented (never auto-approved)", async () => {
    await withWriteManager(["write_deal"], async (manager, crm) => {
      const gate = new PolicyApprovalGate({ allowlist: [{ server: "crm", tool: "write_deal" }] });
      const orch = new Orchestrator({ manager, audit: new InMemoryAuditLogger(), writeGate: gate });
      const results = await orch.write([crmWrite]);
      expect(results[0]).toMatchObject({ allowed: false, reason: "no-approval" });
      expect(crm.calls.get("write_deal")).toBeUndefined();
    });
  });

  it("surfaces a write failure from the server (approved, then the tool errors)", async () => {
    // A failing tool behind a real allowlisted entry.
    const configs = [serverConfig("crm", ["write_deal"])];
    const crm = await makeInMemoryServer("crm", [{ name: "write_deal", fail: true }]);
    const manager = new McpClientManager(configs, resolver, guard, {
      retry: instantRetry,
      transportFactory: () => crm.transport,
    });
    await manager.connectAll();
    try {
      const audit = new InMemoryAuditLogger();
      const events: ProgressEvent[] = [];
      const gate = new PolicyApprovalGate({ allowlist: [{ server: "crm", tool: "write_deal" }] });
      const approval = { taskId: "w1", approver: "alice", reason: "ok" };
      gate.approve(approval);
      const orch = new Orchestrator({ manager, audit, writeGate: gate, onProgress: (e) => events.push(e) });

      const results = await orch.write([crmWrite], { w1: approval });

      expect(results[0]!.allowed).toBe(true);
      expect(results[0]!.error).toBeDefined();
      expect(results[0]!.error).toMatch(/boom|error/i);
      expect(events.some((e) => e.type === "write-failed")).toBe(true);
      const writeEvents = audit.events().filter((e) => e.type === "write_attempt");
      expect(writeEvents.map((e) => e.data["allowed"])).toEqual([true]);
    } finally {
      await manager.close();
      await crm.close();
    }
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

  it("renders and writes an HTML report when reportFormat is html (issue #14)", async () => {
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
      reportFormat: "html",
      writeReport: async (content, file) => {
        const { writeFile } = await import("node:fs/promises");
        const abs = path.join(dir, file);
        await writeFile(abs, content);
        return abs;
      },
    });

    // No explicit file: the default name takes the format's extension (.html).
    const result = await orch.run({
      goal: "deals report",
      gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
      report: { title: "EMEA Deals" },
    });

    expect(result.reportPath).toMatch(/\.html$/);
    const onDisk = await readFile(result.reportPath!, "utf8");
    // The HTML view carries the claim text and its provenance.
    expect(onDisk).toContain("<!DOCTYPE html>");
    expect(onDisk).toContain("EMEA Deals");
    expect(onDisk).toContain("crm");
    expect(onDisk).toContain("read_deals");
    expect(onDisk).toContain("Provenance");
    // The claim text (the tool's JSON echo) survives the transform; in HTML the
    // double quotes are escaped to &quot; — the substance is unchanged.
    const claimText = JSON.stringify({ region: "emea" });
    expect(onDisk).toContain(claimText.replace(/"/g, "&quot;"));

    await manager.close();
    for (const s of servers) await s.close();
    servers = [];
  });

  it("createOrchestrator writes an HTML report through the real File Manager (FM-08 accepts .html)", async () => {
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
    servers = [crm];
    const manager = new McpClientManager(
      [serverConfig("crm", ["read_deals"])],
      resolver,
      guard,
      { retry: instantRetry, transportFactory: () => crm.transport },
    );
    await manager.connectAll();

    const files = new FileManager({
      confinement: new PathConfinement([dir]),
      policy: {
        confirmation_required: ["delete", "overwrite"],
        undo_depth: 0,
        dry_run_default: false,
        audit_payload_logging: false,
        ignore_patterns: [],
        approval_ttl_seconds: 1800,
      },
    });
    const audit = new InMemoryAuditLogger();
    const orch = createOrchestrator({
      manager,
      audit,
      files,
      reportDir: dir,
      reportFormat: "html",
    });

    const result = await orch.run({
      goal: "deals report",
      gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
      report: { title: "EMEA Deals" },
    });

    expect(result.reportError).toBeUndefined();
    expect(result.reportPath).toMatch(/\.html$/);
    const onDisk = await readFile(result.reportPath!, "utf8");
    expect(onDisk).toContain("<!DOCTYPE html>");
    expect(onDisk).toContain("EMEA Deals");

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
