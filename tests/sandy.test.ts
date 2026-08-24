import { mkdtemp, rm, writeFile, readFile as fsRead } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  SandboxViolationError,
  createLlmEngine,
  createSandy,
  runCli,
  EXIT,
  InMemoryAuditLogger,
  NetworkGuard,
  type LlmConfig,
  type LlmEngine,
  type Sandy,
} from "../src/index.js";
import {
  makeInMemoryServer,
  type TestServer,
} from "./helpers/mcp.js";

const fixtureServer = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));

// Pinned *detected* runtime for the direct createSandy composition tests.
// Without a detection override the real detectRuntime() is used, which reports
// "none" on a bare host (e.g. the CI runner) — a custom-declared boundary is
// then reported degraded and ok flips false. Pin a concrete detected runtime
// ("docker"; the declared runtime stays "custom") so these tests are
// host-independent.
const pinnedDetection = () => ({ runtime: "docker" as const, evidence: ["test"] });

let root: string;
const tmpDirs: string[] = [];
const inMemServers: TestServer[] = [];

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sandy-e2e-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Write a sandy.json + mcp-servers.json pair into `dir`.
 * @param crmCommand the stdio command for the `crm` server. Pass the real
 *   fixture for CLI e2e tests, or a harmless stub for createSandy tests
 *   (whose transportFactory overrides it).
 */
async function writeConfig(
  dir: string,
  opts: {
    allowedPaths: string[];
    runtime?: string;
    crmCommand?: string[];
    extraServers?: unknown[];
    llm?: Record<string, unknown>;
    mode?: string;
    maxCpuPercent?: number;
    preferences?: Record<string, unknown>;
  },
): Promise<string> {
  const crm = {
    name: "crm",
    transport: "stdio",
    command: opts.crmCommand ?? ["true"],
    version: "1.0.0",
    capabilities: ["read_deals"],
    allowed_tools: ["read_deals"],
  };
  const manifest = { servers: [crm, ...(opts.extraServers ?? [])] };
  const main = {
    mode: opts.mode ?? "plugin",
    llm: opts.llm ?? { provider: "host" },
    sandbox: {
      runtime: opts.runtime ?? "custom",
      allowed_paths: opts.allowedPaths,
      allowed_network: [],
      max_memory_mb: 512,
      max_cpu_percent: opts.maxCpuPercent ?? 25,
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
    ...(opts.preferences ? { preferences: opts.preferences } : {}),
  };
  await writeFile(path.join(dir, "mcp-servers.json"), JSON.stringify(manifest, null, 2));
  const cfgPath = path.join(dir, "sandy.json");
  await writeFile(cfgPath, JSON.stringify(main, null, 2));
  return cfgPath;
}

async function writeRequest(dir: string, body: unknown): Promise<string> {
  const p = path.join(dir, "request.json");
  await writeFile(p, JSON.stringify(body, null, 2));
  return p;
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

describe("createSandy: composition (CLI/service spine)", () => {
  it("wires config → sandbox → mcp → files → orchestrator and reports healthy", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, { allowedPaths: [ws] });
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
    inMemServers.push(crm);

    const sandy = await createSandy({
      sandyPath: cfg,
      transportFactory: () => crm.transport,
      detection: pinnedDetection,
    });
    try {
      const report = sandy.check();
      expect(report.sandbox.declaredRuntime).toBe("custom");
      expect(report.sandbox.degraded).toBe(false);
      expect(report.sandbox.lost).toEqual([]);
      expect(report.mcp.connected).toContain("crm");
      expect(report.mcp.failed).toEqual([]);
      expect(report.ok).toBe(true);
    } finally {
      await closeAll([sandy]);
    }
  });

  it("exposes a host LLM engine that records model usage into the audit log (AU-01)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, { allowedPaths: [ws] });
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
    inMemServers.push(crm);

    const sandy = await createSandy({
      sandyPath: cfg,
      transportFactory: () => crm.transport,
      detection: pinnedDetection,
    });
    try {
      // Plugin mode (llm.provider "host") → the host engine.
      expect(sandy.engine.provider).toBe("host");

      const event = sandy.engine.record({
        provider: "claude-code",
        model: "claude-sonnet",
        inputTokens: 100,
        outputTokens: 20,
      });
      expect(event.type).toBe("model_invocation");
      expect(sandy.audit.events().some((e) => e.seq === event.seq)).toBe(true);

      // The bundled/remote engines are a Phase 2 seam: host engine does not
      // invoke a model itself (it throws a clear error, not a silent no-op).
      await expect(sandy.engine.invoke({ prompt: "hi" })).rejects.toThrow(/HOST LLM is the engine/);
    } finally {
      await closeAll([sandy]);
    }
  });

  it("runs a request end-to-end: gathers, writes a confined report, and audits", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, { allowedPaths: [ws] });
    const auditFile = path.join(ws, "audit", "session.jsonl");
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
    inMemServers.push(crm);

    const sandy = await createSandy({
      sandyPath: cfg,
      auditFile,
      transportFactory: () => crm.transport,
      detection: pinnedDetection,
    });
    try {
      const result = await sandy.run({
        goal: "EMEA deals summary",
        gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
        report: { title: "EMEA Deals", file: "emea-deals.md", summary: "Narrative." },
      });

      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]?.source.server).toBe("crm");
      expect(result.claims[0]?.source.argsHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.gaps).toEqual([]);

      const expected = path.join(ws, "reports", "emea-deals.md");
      expect(result.reportPath).toBe(expected);
      const onDisk = await fsRead(expected, "utf8");
      expect(onDisk).toContain("# EMEA Deals");

      const auditTypes = sandy.audit.events().map((e) => e.type);
      expect(auditTypes).toContain("session_start");
      expect(auditTypes).toContain("orchestrator_task");
      expect(auditTypes).toContain("mcp_call");
      expect(auditTypes).toContain("session_end");

      // The JSONL file mirrors the in-memory log once flushed.
      await sandy.audit.close();
      const auditRaw = await fsRead(auditFile, "utf8");
      const fileTypes = auditRaw
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { type: string }).type);
      expect(fileTypes).toContain("session_end");
    } finally {
      await closeAll([sandy]);
    }
  });

  it("renders an HTML report when preferences.default_report_format is html (issue #14)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, {
      allowedPaths: [ws],
      preferences: { default_report_format: "html" },
    });
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
    inMemServers.push(crm);

    const sandy = await createSandy({
      sandyPath: cfg,
      transportFactory: () => crm.transport,
      detection: pinnedDetection,
    });
    try {
      const result = await sandy.run({
        goal: "EMEA deals summary",
        gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
        report: { title: "EMEA Deals" },
      });

      // The default filename takes the format's extension, and the on-disk
      // content is the HTML view (claims + provenance survive the transform).
      expect(result.reportPath).toMatch(/\.html$/);
      const onDisk = await fsRead(result.reportPath!, "utf8");
      expect(onDisk).toContain("<!DOCTYPE html>");
      expect(onDisk).toContain("EMEA Deals");
      expect(onDisk).toContain("Provenance");
    } finally {
      await closeAll([sandy]);
    }
  });

  it("refuses to start when preferences.default_report_format is unimplemented (fail-closed)", async () => {
    const ws = await tmpWorkspace();
    for (const format of ["docx", "xlsx", "pdf"]) {
      const cfg = await writeConfig(ws, {
        allowedPaths: [ws],
        preferences: { default_report_format: format },
      });
      await expect(createSandy({ sandyPath: cfg, detection: pinnedDetection })).rejects.toThrow(
        /default_report_format/,
      );
    }
  });

  it("reports a startup-failed MCP server (never throws, never hides it)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, { allowedPaths: [ws] });

    const sandy = await createSandy({
      sandyPath: cfg,
      transportFactory: () => ({
        start: async () => {
          throw new Error("connect ECONNREFUSED");
        },
        send: async () => {
          throw new Error("closed");
        },
        close: async () => {},
      }),
      detection: pinnedDetection,
    });
    try {
      const report = sandy.check();
      expect(report.ok).toBe(false);
      expect(report.mcp.failed.map((f) => f.server)).toEqual(["crm"]);

      const result = await sandy.run({
        goal: "deals",
        gather: [{ id: "deals", server: "crm", tool: "read_deals", args: {} }],
      });
      expect(result.claims).toEqual([]);
      expect(result.gaps[0]?.reason).toBe("server-unavailable");
    } finally {
      await closeAll([sandy]);
    }
  });
});

describe("createSandy: fail-closed contract", () => {
  it("refuses to start unsandboxed (declared runtime but none detected)", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, { allowedPaths: [ws], runtime: "docker" });
    await expect(
      createSandy({
        sandyPath: cfg,
        detection: () => ({ runtime: "none", evidence: [] }),
      }),
    ).rejects.toThrow(SandboxViolationError);
  });

  it("fails closed on an invalid config (missing file)", async () => {
    const ws = await tmpWorkspace();
    await expect(createSandy({ sandyPath: path.join(ws, "does-not-exist.json") })).rejects.toThrow(
      ConfigError,
    );
  });
});

describe("createLlmEngine: reasoning-layer seam (PRD §7, AU-01, SD-02/04)", () => {
  const audit = () => new InMemoryAuditLogger();

  it("builds the host engine for llm.provider 'host' (plugin mode)", () => {
    const engine = createLlmEngine({ provider: "host" } as LlmConfig, audit());
    expect(engine.provider).toBe("host");
    const event = engine.record({ inputTokens: 5, outputTokens: 6 });
    expect(event.type).toBe("model_invocation");
    expect((event.data as Record<string, unknown>)["provider"]).toBe("host");
  });

  it("builds the local engine for llm.provider 'local' (needs model + model_path)", () => {
    const engine = createLlmEngine(
      { provider: "local", model: "llama-7b", model_path: "/models/x.gguf" } as LlmConfig,
      audit(),
    );
    expect(engine.provider).toBe("local");
    expect(engine.isReady()).toBe(false); // lazy: not started yet
    expect(engine.status().status).toBe("not-started");
  });

  it("builds the remote engine for llm.provider 'remote' (needs endpoint + a guard)", () => {
    const engine = createLlmEngine(
      { provider: "remote", endpoint: "http://model.internal:8080" } as LlmConfig,
      audit(),
      { guard: new NetworkGuard(["model.internal:8080"]) },
    );
    expect(engine.provider).toBe("remote");
    expect(engine.isReady()).toBe(false);
  });

  it("fails closed on missing local model_path or a missing remote guard", () => {
    expect(() =>
      createLlmEngine({ provider: "local", model: "llama-7b" } as LlmConfig, audit()),
    ).toThrow(/model_path/);
    expect(() =>
      createLlmEngine({ provider: "remote", endpoint: "http://x" } as LlmConfig, audit()),
    ).toThrow(/egress guard/);
  });
});

describe("createSandy: engine wiring (PRD §7)", () => {
  it("exposes engine health in check() and a degraded engine flips ok:false", async () => {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, { allowedPaths: [ws] });
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
    inMemServers.push(crm);
    const broken: LlmEngine = {
      provider: "broken",
      start: async () => {},
      isReady: () => false,
      status: () => ({ status: "degraded", error: "model process died" }),
      record: () => ({ seq: 0, at: "", type: "model_invocation", data: {} }),
      invoke: async () => {
        throw new Error("no");
      },
      close: async () => {},
    };
    const sandy = await createSandy({
      sandyPath: cfg,
      transportFactory: () => crm.transport,
      engine: broken,
      detection: pinnedDetection,
    });
    try {
      const report = sandy.check();
      expect(report.engine.status).toBe("degraded");
      expect(report.engine.error).toBe("model process died");
      expect(report.ok).toBe(false); // a degraded engine is a reported, not crash, state
    } finally {
      await closeAll([sandy]);
    }
  });

  it("maps the sandbox CPU cap to the model's --threads budget (local engine, §4.5)", async () => {
    const ws = await tmpWorkspace();
    const modelPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const spawnArgs: string[] = [];
    // A fake model server: report a fixed port on stderr (like the real
    // llama-server) so start()'s port discovery resolves, and answer /health.
    const child = {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      on: (() => child) as any,
      once: (() => child) as any,
      kill: () => {
        child.stderr.emit("close");
        return true;
      },
      exitCode: null,
      signalCode: null,
    };
    const cfg = await writeConfig(ws, {
      allowedPaths: [ws],
      mode: "standalone",
      maxCpuPercent: 25,
      llm: {
        provider: "local",
        model: "test-model",
        model_path: modelPath,
        engine: { host: "127.0.0.1", port: 9999 }, // fixed port -> no discovery needed
      },
    });
    const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
    inMemServers.push(crm);
    const fetchImpl = (async (url: string) =>
      url.includes("/health")
        ? new Response("ok", { status: 200 })
        : new Response(
            JSON.stringify({
              choices: [{ message: { content: "{}" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { status: 200 },
          )) as typeof fetch;
    const sandy = await createSandy({
      sandyPath: cfg,
      transportFactory: () => crm.transport,
      detection: pinnedDetection,
      engineSpawn: (argv) => {
        spawnArgs.push(...argv);
        return child as any;
      },
      engineFetch: fetchImpl,
    });
    try {
      expect(sandy.engine.provider).toBe("local");
      await sandy.engine.start();
      const i = spawnArgs.indexOf("--threads");
      expect(i).toBeGreaterThanOrEqual(0);
      const cpusCount = (await import("node:os")).cpus().length;
      expect(spawnArgs[i + 1]).toBe(
        String(Math.max(1, Math.floor((cpusCount * 25) / 100))),
      );
    } finally {
      await closeAll([sandy]);
    }
  });
});

describe("runCli: verbs + exit codes (real stdio MCP server)", () => {
  // The CLI builds createSandy internally; runCli's second parameter lets a
  // caller inject SandyDeps overrides (detection, in this case) without any
  // ambient env var. This keeps the CLI tests deterministic on any host (CI
  // runs on a bare VM where detectRuntime() reports "none", which a
  // custom-declared boundary would flag as degraded) with no production code
  // path able to spoof sandbox detection.
  const cliOverrides = { detection: () => ({ runtime: "docker" as const, evidence: ["test override"] }) };

  const stdioCommand = [process.execPath, fixtureServer];

  async function fixtures(): Promise<{ cfg: string; ws: string; req: string }> {
    const ws = await tmpWorkspace();
    const cfg = await writeConfig(ws, { allowedPaths: [ws], crmCommand: stdioCommand });
    const req = await writeRequest(ws, {
      goal: "deals",
      gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
      report: { title: "Deals", file: "deals.md" },
    });
    return { cfg, ws, req };
  }

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

  it("check --json exits 0 and emits a parseable, healthy report", async () => {
    const { cfg } = await fixtures();
    const { value, stdout } = await captureStdout(() =>
      runCli(["check", "--config", cfg, "--json", "--no-progress"], cliOverrides),
    );
    expect(value).toBe(EXIT.ok);
    const parsed = JSON.parse(stdout) as { ok: boolean; mcp: { connected: string[] } };
    expect(parsed.ok).toBe(true);
    expect(parsed.mcp.connected).toContain("crm");
  });

  it("run <request> exits 0 and writes a confined report", async () => {
    const { cfg, ws, req } = await fixtures();
    const { value } = await captureStdout(() =>
      runCli(["run", req, "--config", cfg, "--no-progress"], cliOverrides),
    );
    expect(value).toBe(EXIT.ok);
    const report = await fsRead(path.join(ws, "reports", "deals.md"), "utf8");
    expect(report).toContain("# Deals");
    expect(report).toContain("2 deals closed in emea");
  });

  it("missing config file exits with the config code (fail-closed)", async () => {
    const { value } = await captureStdout(() => runCli(["check", "--config", path.join(root, "nope.json")], cliOverrides));
    expect(value).toBe(EXIT.config);
  });

  it("invalid request file exits with the usage code", async () => {
    const ws = await tmpWorkspace();
    const bad = path.join(ws, "bad-request.json");
    await writeFile(bad, JSON.stringify({ goal: "x", gather: [] }));
    const { value } = await captureStdout(() => runCli(["run", bad, "--config", path.join(root, "nope.json")], cliOverrides));
    expect(value).toBe(EXIT.usage);
  });

  it("unknown verb exits with the usage code", async () => {
    const { value } = await captureStdout(() => runCli(["frobnicate"]));
    expect(value).toBe(EXIT.usage);
  });

  it("--help exits 0 and prints usage", async () => {
    const { value, stdout } = await captureStdout(() => runCli(["--help"]));
    expect(value).toBe(EXIT.ok);
    expect(stdout).toContain("sandy check");
    expect(stdout).toContain("exit codes");
  });
});
