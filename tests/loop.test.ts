import { mkdtemp, rm, writeFile, readFile as fsRead } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSandy,
  NoModelEngineError,
  HostLlmEngine,
  AutonomousLoop,
  runCli,
  EXIT,
  type LlmEngine,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  type AuditEvent,
  type EngineStatus,
  type TransportFactory,
  type Sandy,
} from "../src/index.js";
import { makeInMemoryServer, type TestServer } from "./helpers/mcp.js";
import type { AuditLogger } from "../src/audit/logger.js";
import { InMemoryAuditLogger } from "../src/audit/logger.js";

// Pinned *detected* runtime (host-independent, same as sandy.test.ts).
const pinnedDetection = () => ({ runtime: "docker" as const, evidence: ["test"] });

let root: string;
const tmpDirs: string[] = [];
const inMemServers: TestServer[] = [];

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sandy-loop-"));
  tmpDirs.push(dir);
  return dir;
}

async function writeConfig(dir: string, allowedPaths: string[]): Promise<string> {
  const crm = {
    name: "crm",
    transport: "stdio",
    command: ["true"],
    version: "1.0.0",
    capabilities: ["read_deals"],
    allowed_tools: ["read_deals"],
  };
  const manifest = { servers: [crm] };
  const main = {
    mode: "standalone",
    llm: { provider: "local", model: "stub", model_path: "/models/stub.gguf" },
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

async function closeAll(sandies: Sandy[]): Promise<void> {
  for (const s of sandies) await s.close();
}

beforeAll(async () => {
  root = await tmpWorkspace();
});

afterAll(async () => {
  for (const s of inMemServers.splice(0)) await s.close();
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// --- scripted engine ---------------------------------------------------------

type ScriptedStep =
  | { completion: string; inputTokens?: number; outputTokens?: number }
  | { error: string };

/**
 * An in-process engine whose responses are scripted per invoke. Records every
 * invocation into the composed audit logger (like the real engines) so the
 * audit assertions hold. Drives the loop deterministically with no model/GPU.
 */
class ScriptedEngine implements LlmEngine {
  readonly provider = "stub";
  private readonly steps: ScriptedStep[];
  private readonly audit: AuditLogger;
  private call = 0;
  /** Captured prompts (test: assert the retry fed the error back). */
  readonly prompts: string[] = [];

  constructor(steps: ScriptedStep[], audit: AuditLogger) {
    this.steps = steps;
    this.audit = audit;
  }

  get invocations(): number {
    return this.call;
  }

  async start(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  status(): EngineStatus {
    return { status: "ready", model: "stub" };
  }
  record(invocation: ModelUsage): AuditEvent {
    const d: Record<string, unknown> = { provider: this.provider };
    if (invocation.inputTokens !== undefined) d.inputTokens = invocation.inputTokens;
    if (invocation.outputTokens !== undefined) d.outputTokens = invocation.outputTokens;
    if (invocation.outcome !== undefined) d.outcome = invocation.outcome;
    if (invocation.error !== undefined) d.error = invocation.error;
    return this.audit.append("model_invocation", d);
  }
  async invoke(request: ModelRequest): Promise<ModelResult> {
    this.prompts.push(request.prompt);
    const step = this.steps[Math.min(this.call, this.steps.length - 1)]!;
    this.call += 1;
    if ("error" in step) {
      this.record({ outcome: "error", error: step.error });
      throw new Error(step.error);
    }
    const usage = {
      inputTokens: step.inputTokens ?? 1,
      outputTokens: step.outputTokens ?? 1,
      durationMs: 0,
    };
    this.record({ ...usage, completion: step.completion });
    return { completion: step.completion, ...usage };
  }
  async close(): Promise<void> {}
}

const PLAN_OK = JSON.stringify({
  goal: "Summarize EMEA deals",
  gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
  report: { title: "EMEA Deals" },
});

const NARRATIVE = "Two deals closed in EMEA this quarter per the CRM.";

/** Stand up the in-memory `crm` server and return a transport factory. */
async function crmServer(): Promise<TransportFactory> {
  const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
  inMemServers.push(crm);
  return () => crm.transport;
}

describe("AutonomousLoop (Phase 2, design §2.1)", () => {
  it("happy path: parse → run → narrate, with a labeled narrative in the report", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const transport = await crmServer();
    const engine = new ScriptedEngine([{ completion: PLAN_OK }, { completion: NARRATIVE }], new InMemoryAuditLogger());
    const sandy = await createSandy({ sandyPath: cfg, transportFactory: transport, detection: pinnedDetection, engine });
    try {
      // Point the engine's invocations at the composed audit (the loop records
      // its own events there too), so every assertion is against one log.
      (engine as unknown as { audit: AuditLogger }).audit = sandy.audit;
      const r = await sandy.ask("Summarize EMEA deals");

      expect(r.plan.source).toBe("model");
      expect(r.plan.attempts).toBe(1);
      expect(r.claims).toHaveLength(1);
      expect(r.claims[0]!.source.server).toBe("crm");
      expect(r.gaps).toEqual([]);

      // The report was written and re-written with the narrative.
      expect(r.reportPath).toBeTruthy();
      const onDisk = await fsRead(r.reportPath!, "utf8");
      expect(onDisk).toContain("## Summary");
      expect(onDisk).toContain(NARRATIVE);
      expect(onDisk).toContain("model narrative");
      expect(r.narrative?.text).toBe(NARRATIVE);

      // Two model calls: the parse (plan) + the narrate. All in one audit log.
      expect(engine.invocations).toBe(2);
      const events = sandy.audit.events();
      expect(events.filter((e) => e.type === "model_invocation")).toHaveLength(2);
      expect(events.some((e) => e.type === "standalone_parse")).toBe(true);
      expect(events.some((e) => e.type === "standalone_plan")).toBe(true);
      expect(events.some((e) => e.type === "standalone_narrate")).toBe(true);
      const planEvent = events.find((e) => e.type === "standalone_plan")!;
      expect((planEvent.data as Record<string, unknown>)["source"]).toBe("model");
    } finally {
      await closeAll([sandy]);
    }
  });

  it("bounded retry: feeds the rejection back, then accepts a fixed plan", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const transport = await crmServer();
    const engine = new ScriptedEngine(
      [
        { completion: "Sorry, here is my plan: " + JSON.stringify({ goal: "x", gather: [] }) },
        { completion: PLAN_OK },
        { completion: NARRATIVE },
      ],
      new InMemoryAuditLogger(),
    );
    const sandy = await createSandy({ sandyPath: cfg, transportFactory: transport, detection: pinnedDetection, engine });
    try {
      const r = await sandy.ask("Summarize EMEA deals");
      expect(r.plan.source).toBe("model");
      expect(r.plan.attempts).toBe(2); // first attempt rejected, second accepted
      // The retry prompt carried the rejection reason (error fed back).
      expect(engine.prompts[1]).toContain("rejected");
      expect(r.claims).toHaveLength(1);
    } finally {
      await closeAll([sandy]);
    }
  });

  it("rejects a plan that names an illegal server/tool (the model proposes, the schema disposes)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const transport = await crmServer();
    const bad = JSON.stringify({
      goal: "x",
      gather: [{ id: "h", server: "hr", tool: "read_pii", args: {} }],
    });
    const engine = new ScriptedEngine([{ completion: bad }, { completion: PLAN_OK }, { completion: NARRATIVE }], new InMemoryAuditLogger());
    const sandy = await createSandy({ sandyPath: cfg, transportFactory: transport, detection: pinnedDetection, engine });
    try {
      (engine as unknown as { audit: AuditLogger }).audit = sandy.audit;
      const r = await sandy.ask("Summarize EMEA deals");
      expect(r.plan.attempts).toBe(2);
      expect(r.claims).toHaveLength(1); // recovered to the legal plan
      const firstParse = sandy.audit.events().find((e) => e.type === "standalone_parse")!;
      expect((firstParse.data as Record<string, unknown>)["outcome"]).toBe("invalid-plan");
    } finally {
      await closeAll([sandy]);
    }
  });

  it("deterministic fallback: an all-failing parse names a single tool, so it plans that one task", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const transport = await crmServer();
    // Three garbage parse attempts (hit the cap) → fallback; a 4th step is the
    // narrate call (the model is alive — only *planning* failed).
    const engine = new ScriptedEngine(
      [
        { completion: "I cannot do that." },
        { completion: "{ not json" },
        { completion: "still no" },
        { completion: NARRATIVE },
      ],
      new InMemoryAuditLogger(),
    );
    const sandy = await createSandy({ sandyPath: cfg, transportFactory: transport, detection: pinnedDetection, engine });
    try {
      (engine as unknown as { audit: AuditLogger }).audit = sandy.audit;
      const r = await sandy.ask("please read_deals for emea");
      expect(r.plan.source).toBe("fallback");
      expect(r.plan.attempts).toBe(3); // hit the cap, then fell back
      expect(r.request?.gather).toHaveLength(1);
      expect(r.request?.gather[0]!.server).toBe("crm");
      expect(r.request?.gather[0]!.tool).toBe("read_deals");
      expect(r.claims).toHaveLength(1);
      // The deterministic plan ran, and the (alive) model still narrated it.
      expect(r.narrative?.text).toBe(NARRATIVE);
      const planEvent = sandy.audit.events().find((e) => e.type === "standalone_plan")!;
      expect((planEvent.data as Record<string, unknown>)["source"]).toBe("fallback");
    } finally {
      await closeAll([sandy]);
    }
  });

  it("a model that dies after the fallback plan: narrate is skipped, the report still stands", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const transport = await crmServer();
    // Three garbage parse attempts → fallback; the narrate call then dies.
    const engine = new ScriptedEngine(
      [
        { completion: "nope" },
        { completion: "nope" },
        { completion: "nope" },
        { error: "model process died" },
      ],
      new InMemoryAuditLogger(),
    );
    const sandy = await createSandy({ sandyPath: cfg, transportFactory: transport, detection: pinnedDetection, engine });
    try {
      (engine as unknown as { audit: AuditLogger }).audit = sandy.audit;
      const r = await sandy.ask("please read_deals for emea");
      expect(r.plan.source).toBe("fallback");
      expect(r.claims).toHaveLength(1);
      expect(r.reportPath).toBeTruthy();
      const onDisk = await fsRead(r.reportPath!, "utf8");
      expect(onDisk).not.toContain("## Summary"); // no narrative, deterministic report stands
      const narrateEvent = sandy.audit.events().find((e) => e.type === "standalone_narrate")!;
      expect((narrateEvent.data as Record<string, unknown>)["outcome"]).toBe("error");
    } finally {
      await closeAll([sandy]);
    }
  });

  it("refuse-and-report: a failing parse with no single named tool yields an explicit gap, no invented plan", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const transport = await crmServer();
    const engine = new ScriptedEngine(
      [{ completion: "nope" }, { completion: "nope" }, { completion: "nope" }],
      new InMemoryAuditLogger(),
    );
    const sandy = await createSandy({ sandyPath: cfg, transportFactory: transport, detection: pinnedDetection, engine });
    try {
      const r = await sandy.ask("do something clever");
      expect(r.plan.source).toBe("refused");
      expect(r.claims).toEqual([]);
      expect(r.request).toBeUndefined(); // nothing invented
      expect(r.gaps).toHaveLength(1);
      expect(r.gaps[0]!.reason).toBe("call-failed");
      expect(r.gaps[0]!.detail).toContain("could not derive a plan");
    } finally {
      await closeAll([sandy]);
    }
  });

  it("a dead model during parse degrades to the deterministic fallback (reported, not a crash)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const transport = await crmServer();
    const engine = new ScriptedEngine(
      [
        { error: "model server exited unexpectedly" },
        { error: "model server exited unexpectedly" },
        { error: "model server exited unexpectedly" },
      ],
      new InMemoryAuditLogger(),
    );
    const sandy = await createSandy({ sandyPath: cfg, transportFactory: transport, detection: pinnedDetection, engine });
    try {
      const r = await sandy.ask("please read_deals for emea");
      expect(r.plan.source).toBe("fallback");
      expect(r.claims).toHaveLength(1); // the deterministic single task still ran
    } finally {
      await closeAll([sandy]);
    }
  });

  it("narrate failure degrades gracefully: the deterministic report stands", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const transport = await crmServer();
    const engine = new ScriptedEngine(
      [
        { completion: PLAN_OK },
        { error: "model process died" },
      ],
      new InMemoryAuditLogger(),
    );
    const sandy = await createSandy({ sandyPath: cfg, transportFactory: transport, detection: pinnedDetection, engine });
    try {
      (engine as unknown as { audit: AuditLogger }).audit = sandy.audit;
      const r = await sandy.ask("Summarize EMEA deals");
      expect(r.plan.source).toBe("model");
      expect(r.claims).toHaveLength(1);
      // The report exists (deterministic) but no narrative was added.
      expect(r.reportPath).toBeTruthy();
      const onDisk = await fsRead(r.reportPath!, "utf8");
      expect(onDisk).not.toContain("## Summary");
      const narrateEvent = sandy.audit.events().find((e) => e.type === "standalone_narrate")!;
      expect((narrateEvent.data as Record<string, unknown>)["outcome"]).toBe("error");
    } finally {
      await closeAll([sandy]);
    }
  });

  it("narrative:false skips narrating entirely (one model call)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const transport = await crmServer();
    const engine = new ScriptedEngine([{ completion: PLAN_OK }], new InMemoryAuditLogger());
    const sandy = await createSandy({ sandyPath: cfg, transportFactory: transport, detection: pinnedDetection, engine });
    try {
      const loop = new AutonomousLoop({
        engine,
        orchestrator: sandy.orchestrator,
        audit: sandy.audit,
        files: sandy.files,
        reportDir: sandy.loaded.reportOutputDir,
        tools: [{ server: "crm", tool: "read_deals" }],
        narrative: false,
      });
      const r = await loop.run("Summarize EMEA deals");
      expect(engine.invocations).toBe(1); // only the parse
      expect(r.narrative).toBeUndefined();
      expect(r.claims).toHaveLength(1);
    } finally {
      await closeAll([sandy]);
    }
  });

  it("fails closed against the host engine (plugin mode) instead of degrading", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, [ws]);
    const transport = await crmServer();
    const hostEngine = new HostLlmEngine(new InMemoryAuditLogger());
    const sandy = await createSandy({ sandyPath: cfg, transportFactory: transport, detection: pinnedDetection, engine: hostEngine });
    try {
      await expect(sandy.ask("do a thing")).rejects.toThrow(NoModelEngineError);
    } finally {
      await closeAll([sandy]);
    }
  });
});

describe("runCli: `ask` verb (standalone)", () => {
  process.env["SANDY_TEST_RUNTIME"] = "docker";
  const fixtureServer = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
  const stdioCommand = [process.execPath, fixtureServer];

  function captureStdout<T>(fn: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      out.push(s);
      return true;
    };
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      err.push(s);
      return true;
    };
    return fn().then(
      (value) => {
        process.stdout.write = origOut as typeof process.stdout.write;
        process.stderr.write = origErr as typeof process.stderr.write;
        return { value, stdout: out.join(""), stderr: err.join("") };
      },
      (e: unknown) => {
        process.stdout.write = origOut as typeof process.stdout.write;
        process.stderr.write = origErr as typeof process.stderr.write;
        throw e;
      },
    );
  }

  it("`ask` against a host engine exits usage (mode mismatch, fail-closed)", async () => {
    // The CLI builds its engine from config and cannot inject a model, so a
    // host-configured service must refuse `ask` with a clear usage error.
    const ws = await tmpWorkspace();
    const crm = {
      name: "crm",
      transport: "stdio",
      command: stdioCommand,
      version: "1.0.0",
      capabilities: ["read_deals"],
      allowed_tools: ["read_deals"],
    };
    const manifest = { servers: [crm] };
    const main = {
      mode: "plugin",
      llm: { provider: "host" },
      sandbox: {
        runtime: "custom",
        allowed_paths: [ws],
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
    await writeFile(path.join(ws, "mcp-servers.json"), JSON.stringify(manifest, null, 2));
    const cfgPath = path.join(ws, "sandy.json");
    await writeFile(cfgPath, JSON.stringify(main, null, 2));

    const { value, stderr } = await captureStdout(() => runCli(["ask", "do a thing", "--config", cfgPath]));
    expect(value).toBe(EXIT.usage);
    expect(stderr).toContain("host");
  });

  it("missing goal exits with the usage code", async () => {
    const { value } = await captureStdout(() => runCli(["ask", "--config", path.join(root, "nope.json")]));
    expect(value).toBe(EXIT.usage);
  });
});
