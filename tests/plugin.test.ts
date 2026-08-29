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

async function writeConfig(
  dir: string,
  allowedPaths: string[],
  tools: string[] = ["read_deals"],
  writeAllowlist?: Array<{ server: string; tool: string; args?: Record<string, unknown> }>,
  policy?: Record<string, unknown>,
  preferences?: Record<string, unknown>,
): Promise<string> {
  const manifest = {
    servers: [
      {
        name: "crm",
        transport: "stdio",
        command: ["true"],
        version: "1.0.0",
        capabilities: tools,
        allowed_tools: tools,
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
      ...policy,
    },
    ...(writeAllowlist !== undefined ? { write_allowlist: writeAllowlist } : {}),
    ...(preferences !== undefined ? { preferences } : {}),
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
  tools: string[] = ["read_deals"],
): Promise<{ api: SandyPluginAPI; session: PluginSession; crm: TestServer; close: () => Promise<void> }> {
  const crm = await makeInMemoryServer("crm", tools.map((name) => ({ name })));
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
    crm,
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

  it("sandy.report renders a binary report (docx/xlsx/pdf) and returns the artifact in-band (issue #14)", async () => {
    for (const format of ["docx", "xlsx", "pdf"]) {
      const ws = await tmpWorkspace();
      const cfg = await writeConfig(ws, [ws], ["read_deals"], undefined, undefined, {
        default_report_format: format,
      });
      const { api, close } = await makeSession(cfg);
      try {
        const result = await api.report({
          goal: "EMEA deals",
          gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
          report: { title: "EMEA" },
        });
        expect(result.claims).toHaveLength(1);
        // The default report name is `report-<ts>` + the format's extension,
        // under the confined reports dir.
        expect(result.reportPath).toMatch(new RegExp(`report-\\d+\\.${format}$`));
        expect(result.reportPath!.startsWith(path.join(ws, "reports", "report-"))).toBe(true);
        // The artifact is base64 in-band; a binary report has no string form.
        expect(result.reportArtifactB64).toBeTruthy();
        expect(result.reportContent).toBeUndefined();
        const onDisk = await fsRead(result.reportPath!);
        expect(Buffer.from(result.reportArtifactB64!, "base64").equals(onDisk)).toBe(true);
        if (format === "pdf") {
          expect(onDisk.subarray(0, 5).toString("latin1")).toBe("%PDF-");
        } else {
          expect(onDisk.subarray(0, 2).toString("latin1")).toBe("PK");
        }
        expect(onDisk.toString("latin1")).toContain("EMEA");
      } finally {
        await close();
      }
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

describe("SandyPluginAPI: write-back (issue #16 / Q6)", () => {
  it("sandy.status reports the write posture (disabled by default)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const { api, close } = await makeSession(cfg);
    try {
      expect(api.status({}).write).toEqual({
        enabled: false,
        allowlist: [],
        approvalTtlSeconds: 1800,
      });
    } finally {
      await close();
    }
  });

  it("refuses a write when no write_allowlist is configured (fail closed)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"]);
    const { api, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      const result = await api.write({
        tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: { region: "emea" } }],
        approvals: { w1: { approver: "alice", reason: "user confirmed" } },
      });
      expect(result.results[0]).toMatchObject({ allowed: false, reason: "gate-refused" });
    } finally {
      await close();
    }
  });

  it("refuses a write that is not on the write allowlist, and never touches the wire", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"], [
      { server: "crm", tool: "read_deals" },
    ]);
    const { api, crm, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      const result = await api.write({
        tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: {} }],
        approvals: { w1: { approver: "alice", reason: "user confirmed" } },
      });
      expect(result.results[0]).toMatchObject({ allowed: false, reason: "not-allowed-by-policy" });
      expect(crm.calls.get("write_deal")).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("refuses an allowlisted write with no approval (never auto-approved)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"], [
      { server: "crm", tool: "write_deal" },
    ]);
    const { api, crm, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      const result = await api.write({
        tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: {} }],
      });
      expect(result.results[0]).toMatchObject({ allowed: false, reason: "no-approval" });
      expect(crm.calls.get("write_deal")).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("executes an approved, allowlisted write and audits it (single-use approval)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"], [
      { server: "crm", tool: "write_deal" },
    ]);
    const { api, session, crm, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      const result = await api.write({
        tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: { region: "emea" } }],
        approvals: { w1: { approver: "alice", reason: "user confirmed" } },
      });
      expect(result.results[0]).toMatchObject({ task: "w1", allowed: true });
      expect(result.results[0]!.error).toBeUndefined();
      expect(crm.calls.get("write_deal")).toBe(1);
      expect(crm.lastArgs.get("write_deal")).toEqual({ region: "emea" });
      // The write is a distinct audited event, with the approver.
      const writeEvents = session.sandy.audit.events().filter((e) => e.type === "write_attempt");
      expect(writeEvents).toHaveLength(1);
      expect(writeEvents[0]!.data).toMatchObject({ allowed: true, approver: "alice", approval_reason: "user confirmed" });
      // The approval is single-use: re-invoking with the same approval is refused.
      const replay = await api.write({
        tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: { region: "emea" } }],
        approvals: { w1: { approver: "alice", reason: "user confirmed" } },
      });
      expect(replay.results[0]).toMatchObject({ allowed: false, reason: "no-approval" });
      expect(crm.calls.get("write_deal")).toBe(1);
    } finally {
      await close();
    }
  });

  it("reports a structured error when an approved write fails at the server", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"], [
      { server: "crm", tool: "write_deal" },
    ]);
    const crm = await makeInMemoryServer("crm", [
      { name: "read_deals" },
      { name: "write_deal", fail: true },
    ]);
    inMem.push(crm);
    const cache = new SessionCache({
      transportFactory: () => crm.transport,
      detection: () => ({ runtime: "docker" as const, evidence: ["test"] }),
    });
    const session = await cache.get(cfg);
    const api = new SandyPluginAPI(session);
    try {
      const result = await api.write({
        tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: {} }],
        approvals: { w1: { approver: "alice", reason: "ok" } },
      });
      expect(result.results[0]).toMatchObject({ allowed: true });
      expect(result.results[0]!.error).toBeDefined();
      expect(result.results[0]!.error).toMatch(/boom|error/i);
    } finally {
      await cache.closeAll();
      await crm.close();
    }
  });

  it("rejects a malformed write body with a ToolInputError", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const { api, close } = await makeSession(cfg);
    try {
      await expect(api.write({ tasks: [] })).rejects.toThrow(ToolInputError);
      await expect(api.write({ tasks: [{ id: "w1", server: "crm", tool: "t", args: {} }], approvals: { w1: { approver: "a" } } })).rejects.toThrow(ToolInputError);
    } finally {
      await close();
    }
  });
});

describe("SandyPluginAPI: write-back v2 (issue #16 — consent, expiry, revocation, per-arg)", () => {
  it("sandy.write with no approval surfaces needsApproval (the consent prompt), not just a refusal", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"], [{ server: "crm", tool: "write_deal" }]);
    const { api, crm, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      const result = await api.write({
        tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: { region: "emea" } }],
      });
      // Refused (never auto-approved), and the host is told how to proceed.
      expect(result.results[0]).toMatchObject({ allowed: false, reason: "no-approval" });
      expect(crm.calls.get("write_deal")).toBeUndefined();
      expect(result.needsApproval).toEqual([
        { taskId: "w1", server: "crm", tool: "write_deal", args: { region: "emea" }, approvalTtlSeconds: 1800 },
      ]);
    } finally {
      await close();
    }
  });

  it("sandy.write does NOT surface needsApproval for a policy refusal (asking can't make it legal)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"], [{ server: "crm", tool: "read_deals" }]);
    const { api, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      // write_deal is not on the write allowlist — a policy refusal.
      const offList = await api.write({
        tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: {} }],
      });
      expect(offList.results[0]).toMatchObject({ allowed: false, reason: "not-allowed-by-policy" });
      expect(offList.needsApproval).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("the consent flow: needsApproval → sandy.write.approve → sandy.write proceeds on the recorded consent", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"], [{ server: "crm", tool: "write_deal" }]);
    const { api, session, crm, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      const first = await api.write({
        tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: { region: "emea" } }],
      });
      expect(first.results[0]).toMatchObject({ allowed: false, reason: "no-approval" });

      // The host gets the user's consent and records it ahead of time.
      const receipt = api.writeApprove({ taskId: "w1", approver: "alice", reason: "user said yes" });
      expect(receipt.approved).toBe(true);
      expect(receipt.expiresAt).toBeDefined();
      expect(receipt.approvalTtlSeconds).toBe(1800);

      // A later sandy.write for the same task proceeds on that consent — no
      // inline approval needed.
      const second = await api.write({
        tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: { region: "emea" } }],
      });
      expect(second.results[0]).toMatchObject({ task: "w1", allowed: true });
      expect(crm.calls.get("write_deal")).toBe(1);
      // Two audited write attempts: the first refusal (no-approval), then the
      // approved write — with the out-of-band approver named.
      const attempts = session.sandy.audit.events().filter((e) => e.type === "write_attempt");
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.data).toMatchObject({ allowed: false, reason: "no-approval" });
      expect(attempts[1]?.data).toMatchObject({ allowed: true, approver: "alice" });
    } finally {
      await close();
    }
  });

  it("sandy.write.approve refuses a duplicate (taskId, approver) — no replay", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"], [{ server: "crm", tool: "write_deal" }]);
    const { api, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      const a = api.writeApprove({ taskId: "w1", approver: "alice", reason: "ok" });
      expect(a.approved).toBe(true);
      const b = api.writeApprove({ taskId: "w1", approver: "alice", reason: "ok" });
      expect(b.approved).toBe(false);
      expect(b.reason).toMatch(/already|revoked/);
    } finally {
      await close();
    }
  });

  it("sandy.write.approve fails closed when write-back is not enabled (no allowlist)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"]);
    const { api, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      const r = api.writeApprove({ taskId: "w1", approver: "alice", reason: "ok" });
      expect(r.approved).toBe(false);
      expect(r.reason).toMatch(/not enabled/);
    } finally {
      await close();
    }
  });

  it("sandy.write.revoke withdraws a recorded consent; the write is then refused approval-revoked", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"], [{ server: "crm", tool: "write_deal" }]);
    const { api, crm, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      api.writeApprove({ taskId: "w1", approver: "alice", reason: "ok" });
      // The user changes their mind.
      const revoked = api.writeRevoke({ taskId: "w1" });
      expect(revoked.revoked).toBe(1);
      // The consent is gone: decide falls through to no-approval.
      const after = await api.write({ tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: {} }] });
      expect(after.results[0]).toMatchObject({ allowed: false, reason: "no-approval" });
      expect(crm.calls.get("write_deal")).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("sandy.write.revoke of nothing is 0 (a no-op, not an error)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"], [{ server: "crm", tool: "write_deal" }]);
    const { api, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      expect(api.writeRevoke({ taskId: "w1" }).revoked).toBe(0);
    } finally {
      await close();
    }
  });

  it("refuses a write whose args fall outside the entry's per-arg constraints (args-not-allowed)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"], [
      { server: "crm", tool: "write_deal", args: { region: { enum: ["emea"] } } },
    ]);
    const { api, crm, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      const result = await api.write({
        tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: { region: "latam" } }],
        approvals: { w1: { approver: "alice", reason: "ok" } },
      });
      expect(result.results[0]).toMatchObject({ allowed: false, reason: "args-not-allowed" });
      expect(crm.calls.get("write_deal")).toBeUndefined();
      // A policy refusal is not a consent gap.
      expect(result.needsApproval).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("allows a write whose args satisfy the entry's per-arg constraints", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws], ["read_deals", "write_deal"], [
      { server: "crm", tool: "write_deal", args: { region: { enum: ["emea"] } } },
    ]);
    const { api, crm, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      const result = await api.write({
        tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: { region: "emea" } }],
        approvals: { w1: { approver: "alice", reason: "ok" } },
      });
      expect(result.results[0]).toMatchObject({ allowed: true });
      expect(crm.calls.get("write_deal")).toBe(1);
    } finally {
      await close();
    }
  });

  it("an expired approval is refused approval-expired (clock-seamed TTL)", async () => {
    const ws = await tmpWorkspace();
    // A 1-second TTL so the test can step past it.
    const cfg = await writeConfig(
      ws,
      [ws],
      ["read_deals", "write_deal"],
      [{ server: "crm", tool: "write_deal" }],
      { approval_ttl_seconds: 1 },
    );
    const { api, close } = await makeSession(cfg, {}, ["read_deals", "write_deal"]);
    try {
      const receipt = api.writeApprove({ taskId: "w1", approver: "alice", reason: "ok" });
      expect(receipt.approved).toBe(true);
      // Step the real clock past the 1s window (the gate uses Date.now).
      await new Promise((r) => setTimeout(r, 1100));
      const result = await api.write({ tasks: [{ id: "w1", server: "crm", tool: "write_deal", args: {} }] });
      expect(result.results[0]).toMatchObject({ allowed: false, reason: "approval-expired" });
      // And it is surfaced as a consent gap (re-consent is the remedy).
      expect(result.needsApproval?.[0]).toMatchObject({ taskId: "w1", approvalTtlSeconds: 1 });
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
           "sandy.write",
           "sandy.write.approve",
           "sandy.write.revoke",
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
