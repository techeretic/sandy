import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

// A file that exists, to satisfy the engine's fail-closed model-file check.
const EXISTING_FILE = fileURLToPath(new URL("../package.json", import.meta.url));
if (!existsSync(EXISTING_FILE)) throw new Error("test fixture path wrong");
import {
  HostLlmEngine,
  LlamaCppEngine,
  NetworkGuard,
  RemoteEngine,
  StubEngine,
  createLlmEngine,
  threadsForCpuPercent,
  InMemoryAuditLogger,
  type AuditEvent,
  type LlmConfig,
} from "../src/index.js";

const audit = () => new InMemoryAuditLogger();
const modelEvents = (a: ReturnType<typeof audit>) =>
  a.events().filter((e: AuditEvent) => e.type === "model_invocation");

// --- fakes ------------------------------------------------------------------

/**
 * A fake `llama-server` child process. The real engine attaches its
 * stdout/stderr/error/exit listeners AFTER the spawn factory returns, so
 * emit/kill are deferred to the next tick (like a real async subprocess) to
 * avoid racing them. Both stdout AND stderr are modeled as readable streams
 * because the engine pipes both: the real `llama-server` announces its port on
 * stderr, while the conformance stub writes it to stdout.
 */
class FakeChild {
  readonly stdout: {
    on: (ev: string, cb: (d: Buffer) => void) => void;
    off: (ev: string, cb: (d: Buffer) => void) => void;
    write: (chunk: string) => void;
  };
  readonly stderr: {
    on: (ev: string, cb: (d: Buffer) => void) => void;
    off: (ev: string, cb: (d: Buffer) => void) => void;
    write: (chunk: string) => void;
  };
  readonly exitCode: number | null = null;
  readonly signalCode: NodeJS.Signals | null = null;
  private readonly em = new EventEmitter();
  killedSignals: string[] = [];
  private readonly stdoutEm = new EventEmitter();
  private readonly stderrEm = new EventEmitter();
  /** Which stream the "listening" line is announced on ("stdout" = the
   *  conformance stub; "stderr" = the real llama-server). */
  private readonly readyStream: "stdout" | "stderr";

  constructor(
    private readonly lines: string[] = ["Server listening at http://127.0.0.1:8081"],
    readyStream: "stdout" | "stderr" = "stdout",
  ) {
    this.readyStream = readyStream;
    this.stdout = {
      on: (ev, cb) => this.stdoutEm.on(ev, cb),
      off: (ev, cb) => this.stdoutEm.off(ev, cb),
      write: (chunk) => this.stdoutEm.emit("data", Buffer.from(chunk)),
    };
    this.stderr = {
      on: (ev, cb) => this.stderrEm.on(ev, cb),
      off: (ev, cb) => this.stderrEm.off(ev, cb),
      write: (chunk) => this.stderrEm.emit("data", Buffer.from(chunk)),
    };
  }

  on(ev: string, cb: (...a: unknown[]) => void): this {
    this.em.on(ev, cb);
    return this;
  }
  once(ev: string, cb: (...a: unknown[]) => void): this {
    this.em.once(ev, cb);
    return this;
  }
  kill(sig?: NodeJS.Signals | string): boolean {
    this.killedSignals.push(sig ?? "SIGTERM");
    // Defer exit so the caller's exit listener is attached first.
    setTimeout(() => this.em.emit("exit", null, "SIGTERM"), 0);
    return true;
  }
  /** Emit the ready lines on the configured stream (the port the test reads).
   *  Deferred. */
  emitReady(): void {
    const em = this.readyStream === "stdout" ? this.stdoutEm : this.stderrEm;
    for (const line of this.lines) {
      setTimeout(() => em.emit("data", Buffer.from(line + "\n")), 0);
    }
  }
  emitError(msg: string): void {
    setTimeout(() => this.em.emit("error", new Error(msg)), 0);
  }
  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

/** A fake fetch that records calls and returns a canned OpenAI-style completion. */
function fakeFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, init });
    return responder(u, init);
  }) as unknown as typeof fetch;
  return { calls, fn };
}

const completionResponse = (content: string, promptTokens = 10, completionTokens = 4): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

// --- StubEngine -------------------------------------------------------------

describe("StubEngine (no model / CI)", () => {
  it("is lazy, starts on first invoke, records a model_invocation, and returns its completion", async () => {
    const a = audit();
    const e = new StubEngine({ audit: a, completion: JSON.stringify({ goal: "g" }) });
    expect(e.isReady()).toBe(false);
    expect(e.status().status).toBe("not-started");

    const r = await e.invoke({ prompt: "hi" });
    expect(r.completion).toBe(JSON.stringify({ goal: "g" }));
    expect(e.isReady()).toBe(true); // started lazily
    const ev = modelEvents(a);
    expect(ev).toHaveLength(1);
    expect((ev[0]!.data as Record<string, unknown>)["inputTokens"]).toBe(1);
    await e.close();
  });

  it("reports degraded when told to fail (dead-model path)", async () => {
    const e = new StubEngine({ audit: audit() });
    await e.start();
    e.fail("model process died");
    expect(e.isReady()).toBe(false);
    expect(e.status().status).toBe("degraded");
    await expect(e.invoke({ prompt: "hi" })).rejects.toThrow(/not ready/);
  });
});

// --- HostLlmEngine ----------------------------------------------------------

describe("HostLlmEngine (plugin mode)", () => {
  it("records host-reported usage and refuses to invoke a model itself", async () => {
    const a = audit();
    const e = new HostLlmEngine(a);
    expect(e.isReady()).toBe(true); // no Sandy-owned backend
    e.record({ provider: "claude-code", inputTokens: 9, outputTokens: 3 });
    const ev = modelEvents(a);
    expect(ev).toHaveLength(1);
    expect((ev[0]!.data as Record<string, unknown>)["provider"]).toBe("claude-code");
    await expect(e.invoke({ prompt: "x" })).rejects.toThrow(/HOST LLM is the engine/);
  });
});

// --- LlamaCppEngine (local) -------------------------------------------------

describe("LlamaCppEngine (local, in-sandbox loopback)", () => {
  it("fails closed when the model file is missing (never tries to start)", async () => {
    const e = new LlamaCppEngine({
      audit: audit(),
      modelPath: "/does/not/exist.gguf",
      model: "m",
      spawnFactory: () => {
        throw new Error("should not spawn");
      },
    });
    await expect(e.start()).rejects.toThrow(/model file not found/);
    expect(e.status().status).toBe("degraded");
  });

  it("starts the server on loopback, discovers its port, and invokes it (recording usage)", async () => {
    const child = new FakeChild(["Server listening at http://127.0.0.1:8081"]);
    const fake = fakeFetch((url) => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      return completionResponse("plan {}", 12, 5);
    });
    const a = audit();
    const e = new LlamaCppEngine({
      audit: a,
      modelPath: EXISTING_FILE, // exists, so the fail-closed check passes
      model: "m",
      spawnFactory: () => {
        child.emitReady();
        return child.asChild();
      },
      fetchImpl: fake.fn,
      logSink: () => {},
    });
    await e.start();
    expect(e.status().status).toBe("ready");
    expect(e.status().port).toBe(8081);

    const r = await e.invoke({ prompt: "plan a report" });
    expect(r.completion).toBe("plan {}");
    const ev = modelEvents(a);
    expect(ev).toHaveLength(1);
    expect((ev[0]!.data as Record<string, unknown>)["inputTokens"]).toBe(12);

    // close() kills the child process (no orphan).
    await e.close();
    expect(child.killedSignals.length).toBeGreaterThan(0);
  });

  it("invoke() kills the child process when the request fails, so the next start() does not orphan it", async () => {
    const child = new FakeChild(["Server listening at http://127.0.0.1:8081"]);
    const fake = fakeFetch((url) => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      throw new Error("model server exploded mid-request");
    });
    const e = new LlamaCppEngine({
      audit: audit(),
      modelPath: EXISTING_FILE,
      model: "m",
      spawnFactory: () => {
        child.emitReady();
        return child.asChild();
      },
      fetchImpl: fake.fn,
      logSink: () => {},
    });
    await e.start();
    expect(e.status().status).toBe("ready");
    await expect(e.invoke({ prompt: "hi" })).rejects.toThrow(/exploded/);
    // The still-running model server must be torn down on failure, not left
    // alive for the next start()'s `this.child = spawnFactory(...)` to silently
    // overwrite (one orphaned llama-server per failed invocation).
    expect(child.killedSignals).toContain("SIGTERM");
  });

  it("discovers the port when the server announces it on STDERR (the real llama-server)", async () => {
    // The real `llama-server` logs to stderr, not stdout. A prior engine read
    // only stdout, so a real model would time out here. This pins the fix.
    const child = new FakeChild(
      [
        "0.00.128.552 W srv  llama_server: CORS is set to allow all origins ('*')",
        "0.02.831.816 I srv  llama_server: listening on http://127.0.0.1:37587",
      ],
      "stderr",
    );
    const fake = fakeFetch((url) => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      return completionResponse("plan {}", 4, 2);
    });
    const e = new LlamaCppEngine({
      audit: audit(),
      modelPath: EXISTING_FILE,
      model: "m",
      spawnFactory: () => {
        child.emitReady();
        return child.asChild();
      },
      fetchImpl: fake.fn,
      // Discard the model's log output (the default would write it to stderr).
      logSink: () => {},
    });
    await e.start();
    expect(e.status().status).toBe("ready");
    expect(e.status().port).toBe(37587);
    const r = await e.invoke({ prompt: "plan a report" });
    expect(r.completion).toBe("plan {}");
    await e.close();
    expect(child.killedSignals.length).toBeGreaterThan(0);
  });

  it("maps the CPU cap to a --threads budget in the spawn argv (§4.5)", async () => {
    const child = new FakeChild(["Server listening at http://127.0.0.1:8081"], "stderr");
    const fake = fakeFetch((url) =>
      url.endsWith("/health") ? new Response("ok", { status: 200 }) : completionResponse("{}", 1, 1),
    );
    let argv: string[] = [];
    const e = new LlamaCppEngine({
      audit: audit(),
      modelPath: EXISTING_FILE,
      model: "m",
      maxThreads: 4,
      spawnFactory: (a) => {
        argv = a;
        child.emitReady();
        return child.asChild();
      },
      fetchImpl: fake.fn,
      logSink: () => {},
    });
    await e.start();
    expect(e.status().status).toBe("ready");
    const i = argv.indexOf("--threads");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe("4");
    await e.close();
  });
});

describe("threadsForCpuPercent (§4.5: CPU cap -> thread budget)", () => {
  it("maps a percentage of logical CPUs down to a thread count, floor >= 1", () => {
    expect(threadsForCpuPercent(100, 16)).toBe(16); // no effective cap
    expect(threadsForCpuPercent(50, 16)).toBe(8);
    expect(threadsForCpuPercent(25, 16)).toBe(4);
    expect(threadsForCpuPercent(50, 8)).toBe(4);
    expect(threadsForCpuPercent(20, 8)).toBe(1); // 1.6 -> floor 1
    expect(threadsForCpuPercent(1, 8)).toBe(1); // rounds down to >=1
    expect(threadsForCpuPercent(3, 8)).toBe(1); // 0.24 -> floor 0 -> clamped to 1
  });
  it("fails to a minimum of 1 thread on invalid input (never 0/negative)", () => {
    expect(threadsForCpuPercent(0, 16)).toBe(1);
    expect(threadsForCpuPercent(-5, 16)).toBe(1);
    expect(threadsForCpuPercent(50, 0)).toBe(1);
    expect(threadsForCpuPercent(NaN, 16)).toBe(1);
    expect(threadsForCpuPercent(50, NaN)).toBe(1);
  });
});

// --- RemoteEngine (SD-04) ---------------------------------------------------

describe("RemoteEngine (SD-04, egress-guarded)", () => {
  it("refuses an endpoint not in the allowlist before any dial (VPN-02)", async () => {
    const guard = new NetworkGuard(["allowed.internal:8080"]);
    const fake = fakeFetch(() => completionResponse("x"));
    const e = new RemoteEngine({
      audit: audit(),
      endpoint: "http://attacker.internal:9999",
      guard,
      fetchImpl: fake.fn,
    });
    await expect(e.start()).rejects.toThrow(/endpoint-not-declared/);
    expect(fake.calls).toHaveLength(0); // never dialed
  });

  it("invokes a declared endpoint, sending a bearer token and recording usage", async () => {
    const guard = new NetworkGuard(["model.internal:8080"]);
    const fake = fakeFetch((url, init) => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      const auth = (init?.headers as Record<string, string>)?.["authorization"];
      expect(auth).toBe("Bearer s3cr3t");
      return completionResponse("remote {}", 7, 2);
    });
    const a = audit();
    const e = new RemoteEngine({
      audit: a,
      endpoint: "http://model.internal:8080",
      bearerToken: "s3cr3t",
      guard,
      fetchImpl: fake.fn,
    });
    const r = await e.invoke({ prompt: "hi" });
    expect(r.completion).toBe("remote {}");
    expect(modelEvents(a)).toHaveLength(1);
    await e.close();
  });
});

// --- structured output ------------------------------------------------------

describe("structured output (the parse step's need)", () => {
  it("forwards responseFormat:'json' to the backend request body", async () => {
    const guard = new NetworkGuard(["model.internal:8080"]);
    let seenBody: unknown;
    const fake = fakeFetch((url, init) => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      seenBody = JSON.parse(String(init?.body));
      return completionResponse("{\"gather\":[]}");
    });
    const e = new RemoteEngine({
      audit: audit(),
      endpoint: "http://model.internal:8080",
      guard,
      fetchImpl: fake.fn,
    });
    await e.invoke({ prompt: "plan", responseFormat: "json", jsonSchema: { type: "object" } });
    expect((seenBody as { response_format: unknown }).response_format).toEqual({
      type: "json_schema",
      json_schema: { type: "object" },
    });
    await e.close();
  });
});

// --- factory ----------------------------------------------------------------

describe("createLlmEngine (factory)", () => {
  it("maps provider to the right engine", () => {
    expect(createLlmEngine({ provider: "host" } as LlmConfig, audit()).provider).toBe("host");
    expect(
      createLlmEngine(
        { provider: "local", model: "m", model_path: "/m.gguf" } as LlmConfig,
        audit(),
      ).provider,
    ).toBe("local");
    expect(
      createLlmEngine(
        { provider: "remote", endpoint: "http://m:1" } as LlmConfig,
        audit(),
        { guard: new NetworkGuard(["m:1"]) },
      ).provider,
    ).toBe("remote");
  });
});
