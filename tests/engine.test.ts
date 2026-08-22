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
 * stdout/error/exit listeners AFTER the spawn factory returns, so emit/kill are
 * deferred to the next tick (like a real async subprocess) to avoid racing them.
 */
class FakeChild {
  readonly stdout: {
    on: (ev: string, cb: (d: Buffer) => void) => void;
    off: (ev: string, cb: (d: Buffer) => void) => void;
    write: (chunk: string) => void;
  };
  readonly stderr: { write: (chunk: string) => void };
  readonly exitCode: number | null = null;
  readonly signalCode: NodeJS.Signals | null = null;
  private readonly em = new EventEmitter();
  killedSignals: string[] = [];

  constructor(private readonly lines: string[] = ["Server listening at http://127.0.0.1:8081"]) {
    const stdoutEm = new EventEmitter();
    this.stdout = {
      on: (ev, cb) => stdoutEm.on(ev, cb),
      off: (ev, cb) => stdoutEm.off(ev, cb),
      write: (chunk) => stdoutEm.emit("data", Buffer.from(chunk)),
    };
    this.stderr = { write: () => {} };
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
  /** Emit the stdout lines (the port the test reads). Deferred. */
  emitReady(): void {
    for (const line of this.lines) {
      setTimeout(() => this.stdout.write(line + "\n"), 0);
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
