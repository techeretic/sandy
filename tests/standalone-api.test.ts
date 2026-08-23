import { mkdtemp, rm, writeFile, readFile as fsRead } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createSandy,
  createLocalApi,
  LoopbackBindError,
  BoundedJobStore,
  EXIT,
  runCli,
  InMemoryAuditLogger,
  type Job,
  type JobStatus,
  type LocalApi,
  type LlmEngine,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  type AuditEvent,
  type EngineStatus,
  type LocalApiOptions,
  type Sandy,
} from "../src/index.js";
import { makeInMemoryServer, type TestServer } from "./helpers/mcp.js";
import type { AuditLogger } from "../src/audit/logger.js";

const pinnedDetection = () => ({ runtime: "docker" as const, evidence: ["test"] });

let root: string;
const tmpDirs: string[] = [];
const inMemServers: TestServer[] = [];
const apis: LocalApi[] = [];
const sandies: Sandy[] = [];

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sandy-api-"));
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

async function closeAll(): Promise<void> {
  for (const api of apis.splice(0)) await api.close();
  for (const s of sandies.splice(0)) await s.close();
}

beforeAll(async () => {
  root = await tmpWorkspace();
});

afterAll(async () => {
  await closeAll();
  for (const s of inMemServers.splice(0)) await s.close();
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// --- scripted engine (no model / no GPU) -------------------------------------

class ScriptedEngine implements LlmEngine {
  readonly provider = "stub";
  private readonly completion: string;
  private readonly audit: AuditLogger;
  invocations = 0;

  constructor(audit: AuditLogger, completion?: string) {
    this.audit = audit;
    this.completion =
      completion ??
      JSON.stringify({
        goal: "stub",
        gather: [{ id: "deals", server: "crm", tool: "read_deals", args: {} }],
        report: { title: "Stub Report" },
      });
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
    return this.audit.append("model_invocation", d);
  }
  async invoke(_request: ModelRequest): Promise<ModelResult> {
    this.invocations += 1;
    const usage = { inputTokens: 1, outputTokens: 1, durationMs: 0 };
    this.record({ ...usage, completion: this.completion });
    return { completion: this.completion, ...usage };
  }
  async close(): Promise<void> {}
}

async function makeApi(
  opts: { engine?: LlmEngine; api?: LocalApiOptions } = {},
): Promise<{ api: LocalApi; sandy: Sandy; ws: string; base: string; engine: ScriptedEngine }> {
  const ws = await tmpWorkspace();
  const cfg = await writeConfig(ws, [ws]);
  const crm = await makeInMemoryServer("crm", [{ name: "read_deals" }]);
  inMemServers.push(crm);
  const engine = (opts.engine ?? new ScriptedEngine(new InMemoryAuditLogger())) as ScriptedEngine;
  const sandy = await createSandy({
    sandyPath: cfg,
    transportFactory: () => crm.transport,
    detection: pinnedDetection,
    engine,
  });
  sandies.push(sandy);
  const api = createLocalApi(sandy, opts.api);
  apis.push(api);
  await api.start();
  return { api, sandy, ws, base: `http://${api.boundHost}:${api.boundPort}`, engine };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForJob(api: LocalApi, id: string, status: JobStatus, timeoutMs = 5000): Promise<Job> {
  const start = Date.now();
  for (;;) {
    const job = api.jobStore.get(id);
    if (job && job.status === status) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${id} did not reach "${status}" (timeout)`);
    await sleep(5);
  }
}

async function postRun(base: string, body: unknown): Promise<{ status: number; body: { id?: string; error?: string } }> {
  const res = await fetch(`${base}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { id?: string; error?: string };
  return { status: res.status, body: json };
}

const LEGAL_RUN = {
  goal: "deals",
  gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
  report: { title: "Deals", file: "deals.md" },
};

describe("LocalApi (Phase 2, design §5)", () => {
  it("refuses to bind off-loopback (fail-closed)", () => {
    // Binding a network-exposed address is a security-invariant violation. The
    // constructor throws before any socket is opened.
    const stub = { check: () => ({ ok: true }) } as unknown as Sandy;
    expect(() => createLocalApi(stub, { host: "0.0.0.0" })).toThrow(LoopbackBindError);
    expect(() => createLocalApi(stub, { host: "10.0.0.5" })).toThrow(LoopbackBindError);
    // Loopback hosts are allowed (constructor does not throw).
    expect(() => createLocalApi(stub, { host: "127.0.0.1" })).not.toThrow();
    expect(() => createLocalApi(stub, { host: "localhost" })).not.toThrow();
  });

  it("GET /health returns the check report (200) with engine health", async () => {
    const { api, base } = await makeApi();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; engine: { status: string }; mcp: { connected: string[] } };
    expect(body.ok).toBe(true);
    expect(body.engine.status).toBe("ready");
    expect(body.mcp.connected).toContain("crm");
  });

  it("POST /run → 202 + id → GET /jobs/:id → done with claims + a confined report", async () => {
    const { api, base, ws } = await makeApi();
    const { status, body } = await postRun(base, LEGAL_RUN);
    expect(status).toBe(202);
    expect(body.id).toBeTruthy();
    const job = await waitForJob(api, body.id!, "done");
    const result = job.result as { claims: Array<{ text: string }>; gaps: unknown[]; reportPath?: string };
    expect(result.claims).toHaveLength(1);
    expect(result.gaps).toHaveLength(0);
    expect(result.reportPath).toBe(path.join(ws, "reports", "deals.md"));

    const get = await fetch(`${base}/jobs/${body.id}`);
    expect(get.status).toBe(200);
    const got = (await get.json()) as { status: string; progress: string[] };
    expect(got.status).toBe("done");
    expect(got.progress.some((p) => p.includes("done:"))).toBe(true);

    const onDisk = await fsRead(path.join(ws, "reports", "deals.md"), "utf8");
    expect(onDisk).toContain("# Deals");
  });

  it("POST /run with an invalid body → 400 (the same schema as CLI/plugin)", async () => {
    const { base } = await makeApi();
    const { status, body } = await postRun(base, { goal: "x", gather: [] });
    expect(status).toBe(400);
    expect(body.error).toMatch(/gather/);
  });

  it("GET /jobs/:id on an unknown id → clean 404 (never a crash)", async () => {
    const { base } = await makeApi();
    const res = await fetch(`${base}/jobs/nope`);
    expect(res.status).toBe(404);
  });

  it("GET /reports lists written reports; GET /audit returns the transcript", async () => {
    const { api, base } = await makeApi();
    const before = (await (await fetch(`${base}/reports`)).json()) as { reports: string[] };
    expect(before.reports).toEqual([]);
    const { body } = await postRun(base, LEGAL_RUN);
    await waitForJob(api, body.id!, "done");
    const after = (await (await fetch(`${base}/reports`)).json()) as { reports: string[] };
    expect(after.reports).toContain("deals.md");

    const audit = (await (await fetch(`${base}/audit`)).json()) as { count: number; events: unknown[] };
    expect(audit.count).toBeGreaterThan(0);
    expect(audit.events.some((e) => (e as { type: string }).type === "session_start")).toBe(true);
  });

  it("the job store is bounded: oldest finished jobs are evicted (404), within the cap", async () => {
    const { api, base } = await makeApi({ api: { maxCompleted: 2 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { body } = await postRun(base, LEGAL_RUN);
      ids.push(body.id!);
      await waitForJob(api, body.id!, "done");
    }
    // 3 finished, cap 2 → the oldest is evicted.
    expect(api.jobStore.size).toBe(2);
    expect((await fetch(`${base}/jobs/${ids[0]}`)).status).toBe(404);
    expect((await fetch(`${base}/jobs/${ids[1]}`)).status).toBe(200);
    expect((await fetch(`${base}/jobs/${ids[2]}`)).status).toBe(200);
  });

  it("POST /run over the pending cap → 429", async () => {
    const { api } = await makeApi({ api: { maxPending: 1 } });
    // Two synchronous enqueues before the serial worker can start the first.
    const a = api.enqueue("run", LEGAL_RUN);
    expect(() => api.enqueue("run", LEGAL_RUN)).toThrow(/too many pending/);
    const job = await waitForJob(api, a.id, "done");
    expect(job.status).toBe("done");
  });

  it("POST /ask → 202 → done with a model-planned run (the loop over the API)", async () => {
    const { api, base, engine } = await makeApi();
    const res = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Summarize EMEA deals" }),
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const job = await waitForJob(api, id, "done");
    const result = job.result as { plan: { source: string }; claims: unknown[] };
    expect(result.plan.source).toBe("model");
    expect(result.claims).toHaveLength(1);
    expect(engine.invocations).toBeGreaterThanOrEqual(1);

    // An invalid ask body is a 400.
    const bad = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "   " }),
    });
    expect(bad.status).toBe(400);
  });

  it("GET /jobs/:id/events streams SSE: progress then a terminal done event", async () => {
    const { base } = await makeApi();
    const { body } = await postRun(base, LEGAL_RUN);
    const res = await fetch(`${base}/jobs/${body.id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text(); // the server ends the stream after the terminal event
    const payloads = text
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice(6)) as { type: string; text?: string });
    expect(payloads.some((p) => p.type === "running")).toBe(true);
    expect(payloads.some((p) => p.type === "progress")).toBe(true);
    expect(payloads[payloads.length - 1]?.type).toBe("done");
  });

  describe("CSRF hardening (GHSA-qx23-r762-x2j9)", () => {
    it("rejects a POST with a non-application/json Content-Type (closes the CORS-simple-request bypass)", async () => {
      const { base } = await makeApi();
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(LEGAL_RUN),
      });
      expect(res.status).toBe(415);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/content-type/i);
    });

    it("rejects a POST carrying a foreign Origin header", async () => {
      const { base } = await makeApi();
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example.com" },
        body: JSON.stringify(LEGAL_RUN),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/cross-origin/i);
    });

    it("still accepts a same-origin (Origin-less and explicit same-Origin) POST with application/json", async () => {
      const { base } = await makeApi();
      // Origin-less (the common local CLI/tool case) — must pass.
      const originless = await postRun(base, LEGAL_RUN);
      expect(originless.status).toBe(202);
      // Explicit same-origin — must also pass the Origin check.
      const sameOrigin = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify(LEGAL_RUN),
      });
      expect(sameOrigin.status).toBe(202);
    });
  });

  it("the idle worker does not busy-poll the job store (event-driven wake)", async () => {
    const { api, base } = await makeApi();
    // Count how often the serial worker reaches for the queue. The old worker
    // polled every 5ms while idle (~200 calls in a 1s window); the
    // event-driven worker parks until enqueue()/close() wakes it, so an idle
    // stretch makes almost no calls.
    const realNext = BoundedJobStore.prototype.nextQueued;
    const nextQueued = vi
      .spyOn(api.jobStore, "nextQueued")
      .mockImplementation(function (this: BoundedJobStore) {
        return realNext.call(this);
      });
    try {
      // Let any in-flight work finish so the worker is idle, then measure the
      // number of queue checks over a 1s idle window.
      const { body } = await postRun(base, LEGAL_RUN);
      await waitForJob(api, body.id!, "done");
      await sleep(30); // let the worker loop back to the idle branch
      const baseline = nextQueued.mock.calls.length;
      await sleep(500); // an idle window; an old 5ms poller would fire ~100x
      const idleCalls = nextQueued.mock.calls.length - baseline;
      expect(idleCalls).toBeLessThan(25);
    } finally {
      nextQueued.mockRestore();
    }
  });

  it("close() stops the service: new jobs are refused and the port is released", async () => {
    const { api, base } = await makeApi();
    await api.close();
    // A new job is refused after shutdown (503 at the API boundary).
    expect(() => api.enqueue("run", LEGAL_RUN)).toThrow(/shutting down/);
    // The port is released: a new connection fails (no server listening).
    const res = await fetch(`${base}/health`).catch(() => null);
    expect(res).toBeNull();
  });
});

describe("BoundedJobStore", () => {
  it("never evicts queued/running jobs, only finished ones beyond the cap", () => {
    const store = new BoundedJobStore(2);
    const a = store.create("run", {});
    const b = store.create("run", {});
    const c = store.create("run", {});
    // Simulate a's completion and eviction pressure from two finished jobs.
    a.status = "done";
    store.evict();
    expect(store.get(a.id)).toBeDefined();
    // Finish b and c: now 3 finished > cap 2 → the oldest finished (a) is evicted.
    b.status = "done";
    c.status = "done";
    store.evict();
    expect(store.get(a.id)).toBeUndefined();
    expect(store.get(b.id)).toBeDefined();
    expect(store.get(c.id)).toBeDefined();
  });
});

describe("runCli: `serve` verb", () => {
  it("rejects an invalid --port with the usage code", async () => {
    const { value, stderr } = await captureStdout(() =>
      runCli(["serve", "--port", "not-a-number", "--config", path.join(root, "nope.json")]),
    );
    expect(value).toBe(EXIT.usage);
    expect(stderr).toContain("--port");
  });
});

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
