import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { LlmConfig } from "./config/schema.js";
import { logModelInvocation, type AuditEvent, type AuditLogger } from "./audit/logger.js";
import type { NetworkGuard } from "./sandbox/network.js";

/**
 * The LLM Engine — the reasoning layer (PRD §7: "either the bundled local model
 * (standalone) or the host LLM (plugin mode)").
 *
 * Two jobs, cleanly split:
 *
 *  - **Record (AU-01).** Every model invocation lands in the audit log with its
 *    token counts. In plugin mode the HOST is the engine, so the host reports
 *    its usage back (via the `sandy.model.usage` tool) and Sandy records it. In
 *    standalone mode a bundled engine records its own invocations. Either way
 *    the audit trail is uniform.
 *  - **Invoke (the Phase 2 seam).** Actually run a model. Only a bundled/remote
 *    engine does this. The interface is fixed (SD-02/SD-04) so a bundled 4–8B
 *    model drops in without rework to the orchestrator/report pipeline.
 *
 * **Lifecycle (Phase 2).** A real engine owns a backend process (llama.cpp).
 * `start()` brings it up, `status()`/`isReady()` report health, and `close()`
 * tears it down. `Sandy.close()` calls `close()` so a model process is never
 * orphaned. `start()` is LAZY — it runs on the first `invoke()` or when a
 * service explicitly starts it — never as a side effect of `createSandy`/`check`.
 */

export type EngineState = "not-started" | "starting" | "ready" | "degraded";

/** A health snapshot for `SandyCheckReport.engine`. */
export interface EngineStatus {
  status: EngineState;
  /** Present when degraded. */
  error?: string;
  /** The logical model name, when known. */
  model?: string;
  /** Bound loopback port, for a local server once started. */
  port?: number;
}

/**
 * A request to a model. `responseFormat`/`jsonSchema` are the structured-output
 * knobs the autonomous parse step needs to reliably get `{ gather, report }`
 * out of a weak model; backends that can't honor them degrade gracefully.
 */
export interface ModelRequest {
  prompt: string;
  model?: string;
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Ask for JSON output (the parse step uses this). */
  responseFormat?: "json";
  /** Optional JSON schema to constrain the JSON output (best-effort). */
  jsonSchema?: unknown;
}

/** The result of a model invocation. */
export interface ModelResult {
  completion: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

export interface ModelUsage {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  outcome?: "ok" | "error";
  error?: string;
  /** Prompt/completion are payloads: persisted only when payload logging is
   *  opted in (AU-02). */
  prompt?: string;
  completion?: string;
}

/**
 * The reasoning-layer seam. Implement it to plug in a model backend; the
 * orchestrator/report pipeline calls it without knowing which engine is behind
 * it. `HostLlmEngine` is the Phase 1 (plugin mode) implementation.
 */
export interface LlmEngine {
  /** Stable provider label, e.g. "host", "local", "remote". */
  readonly provider: string;
  /** Bring the backend up. Idempotent. Fail-closed on error. */
  start(): Promise<void>;
  /** Is the backend up and healthy right now? */
  isReady(): boolean;
  /** A health snapshot (feeds SandyCheckReport.engine). */
  status(): EngineStatus;
  /**
   * Record a model invocation (token counts) into the audit log (AU-01).
   * Returns the stored audit event (the caller can use its `seq` as a receipt).
   */
  record(invocation: ModelUsage): AuditEvent;
  /**
   * Run the model on a prompt. The Phase 1 host engine does NOT implement this —
   * the host reasons outside Sandy — so it throws a clear error. A bundled or
   * remote engine implements it and records the invocation itself.
   */
  invoke(request: ModelRequest): Promise<ModelResult>;
  /** Tear the backend down (kill the child). Idempotent. */
  close(): Promise<void>;
}

// --- shared helpers ---------------------------------------------------------

/** The structured-output knob to forward, if any. A JSON schema is the stronger
 *  constraint, so it wins over a bare json_object request. */
function structuredFormat(request: ModelRequest): unknown | undefined {
  if (request.jsonSchema !== undefined) return { type: "json_schema", json_schema: request.jsonSchema };
  if (request.responseFormat === "json") return { type: "json_object" };
  return undefined;
}

function recordUsage(
  audit: AuditLogger,
  baseProvider: string,
  invocation: ModelUsage,
): AuditEvent {
  const { prompt, completion, provider, model, inputTokens, outputTokens, durationMs, outcome, error } =
    invocation;
  const details = {
    provider: provider ?? baseProvider,
    ...(model !== undefined ? { model } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(error !== undefined ? { error } : {}),
  };
  const hasPayload = prompt !== undefined || completion !== undefined;
  const opts = hasPayload
    ? {
        payload: {
          ...(prompt !== undefined ? { prompt } : {}),
          ...(completion !== undefined ? { completion } : {}),
        },
      }
    : undefined;
  return logModelInvocation(audit, details, opts);
}

// --- HostLlmEngine (Phase 1, plugin mode) -----------------------------------

/**
 * Phase 1 (plugin mode) engine: the HOST LLM is the engine. It never invokes a
 * model itself; it only records the usage the host reports. The lifecycle is a
 * no-op (there is no Sandy-owned backend).
 */
export class HostLlmEngine implements LlmEngine {
  readonly provider = "host";

  constructor(private readonly audit: AuditLogger) {}

  async start(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  status(): EngineStatus {
    return { status: "ready" };
  }
  record(invocation: ModelUsage): AuditEvent {
    return recordUsage(this.audit, this.provider, invocation);
  }
  async invoke(_request: ModelRequest): Promise<ModelResult> {
    throw new Error(
      "no bundled model in this build: in plugin mode the HOST LLM is the engine (PL-03) — " +
        "Sandy does not invoke a model itself. Report host usage via record() (the sandy.model.usage tool).",
    );
  }
  async close(): Promise<void> {}
}

// --- LlamaCppEngine (Phase 2, local) ----------------------------------------

/** The listen URL a model server prints on startup, its port captured.
 *  Matches both the real `llama-server` ("listening on http://127.0.0.1:37587",
 *  on stderr) and the conformance stub ("Server listening at
 *  http://127.0.0.1:8081", on stdout). The host is either a bracketed IPv6
 *  address or a normal hostname/IPv4, then ":<port>". Anchoring to the
 *  scheme+host means an unrelated ":digits" token in the log (e.g. a token id)
 *  can never be mistaken for the port. */
const LISTEN_URL_PORT_RE = /https?:\/\/(?:\[[^\]]+\]|[^\s/:]+):(\d{2,5})/;

/**
 * Map a declared CPU cap (a percentage of the host's logical CPUs) to a
 * llama.cpp `--threads` value. This is the §4.5 "map caps to llama.cpp knobs"
 * lever: it only ever REDUCES the thread budget a model may use (100% → all
 * cores, no effective cap), consistent with tighten-never-loosen. The HARD
 * ceiling is the service manager's cgroup; this is the soft, in-service knob.
 */
export function threadsForCpuPercent(cpuPercent: number, cpuCount: number): number {
  if (
    !Number.isFinite(cpuPercent) ||
    cpuPercent <= 0 ||
    !Number.isFinite(cpuCount) ||
    cpuCount <= 0
  ) {
    return 1;
  }
  return Math.max(1, Math.floor((cpuCount * cpuPercent) / 100));
}

export interface LlamaCppEngineOptions {
  audit: AuditLogger;
  /** Model file (GGUF). Must exist at start() (fail-closed). */
  modelPath: string;
  /** Logical model name (SD-04). */
  model: string;
  /** Command to spawn the server. Default ["llama-server"]. */
  command?: string[];
  /** Loopback host to bind. Default 127.0.0.1. */
  host?: string;
  /** Port; 0 = pick a free one. Default 0. */
  port?: number;
  /**
   * Cap the model's CPU threads (llama.cpp `--threads`). Maps the declared
   * sandbox `max_cpu_percent` to a real startup lever (§4.5): the threads the
   * model may use is a fraction of the host's logical CPUs. The HARD ceiling
   * is the service manager's cgroup; this is the soft, in-service knob.
   * Undefined = let llama.cpp pick.
   */
  maxThreads?: number;
  /** Injectable for tests: a fake spawn. */
  spawnFactory?: (argv: string[], opts: { stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;
  /** Injectable for tests: a fake fetch. */
  fetchImpl?: FetchLike;
  /** Where the model server's stdout/stderr go. Default the process stderr (so
   *  the model's logs stay visible). Injectable for tests (e.g. a no-op). */
  logSink?: (chunk: string) => void;
  /** How long to wait for the server to become ready. Default 15000ms. */
  readyTimeoutMs?: number;
  /** Per-invoke timeout. Default 60000ms. */
  invokeTimeoutMs?: number;
  /** Injectable for tests. */
  now?: () => number;
}

/**
 * A local 4–8B model served by llama.cpp's `llama-server`, driven as a
 * subprocess over an OpenAI-compatible HTTP API on a loopback port. In-sandbox,
 * zero-egress by construction (its only path is loopback to its own process).
 * A model crash is a reported degraded state, never a silent failure.
 */
export class LlamaCppEngine implements LlmEngine {
  readonly provider = "local";
  private readonly audit: AuditLogger;
  private readonly modelPath: string;
  private readonly model: string;
  private readonly command: string[];
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly maxThreads?: number;
  private readonly spawnFactory: (argv: string[], opts: { stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;
  private readonly fetchImpl: FetchLike;
  private readonly logSink: (chunk: string) => void;
  private readonly readyTimeoutMs: number;
  private readonly invokeTimeoutMs: number;
  private readonly now: () => number;

  private child: ChildProcess | null = null;
  private port = 0;
  private base = "";
  private state: EngineState = "not-started";
  private detail: string | undefined;
  private startPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: LlamaCppEngineOptions) {
    this.audit = options.audit;
    this.modelPath = options.modelPath;
    this.model = options.model;
    this.command = options.command ?? ["llama-server"];
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0;
    this.maxThreads = options.maxThreads;
    this.spawnFactory =
      options.spawnFactory ?? ((argv, opts) => spawn(argv[0]!, argv.slice(1), opts));
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.logSink = options.logSink ?? ((chunk) => process.stderr.write(chunk));
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15000;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 60000;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.state === "ready" || this.state === "starting") return this.startPromise ?? Promise.resolve();
    if (this.closed) throw new Error("engine is closed");
    this.state = "starting";
    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } catch (err) {
      this.state = "degraded";
      this.detail = (err as Error).message;
      throw err;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    if (!existsSync(this.modelPath)) {
      throw new Error(`model file not found at ${this.modelPath} (fail-closed); provision it and retry`);
    }
    const argv = [
      ...this.command,
      "--model",
      this.modelPath,
      "--host",
      this.host,
      "--port",
      String(this.requestedPort),
    ];
    // §4.5: map the declared CPU cap to a real lever. A percentage of the host's
    // logical CPUs becomes a `--threads` cap on the model. The hard ceiling is
    // the service manager's cgroup; this is the soft in-service knob.
    if (this.maxThreads !== undefined && this.maxThreads > 0) {
      argv.push("--threads", String(this.maxThreads));
    }
    this.child = this.spawnFactory(argv, { stdio: ["ignore", "pipe", "pipe"] });
    const child = this.child;

    child.on("error", (err) => {
      if (this.state === "ready" || this.state === "starting") {
        this.state = "degraded";
        this.detail = `model server failed to start: ${err.message}`;
      }
    });
    child.on("exit", () => {
      if (!this.closed && (this.state === "ready" || this.state === "starting")) {
        this.state = "degraded";
        this.detail = "model server exited unexpectedly";
      }
    });

    // A real `llama-server` logs (including the "listening on http://host:PORT"
    // line the port discovery below needs) to STDERR, not stdout. Both streams
    // are therefore piped, scanned for the port, and drained for the child's
    // whole life so a long-running model's log output never fills a pipe buffer
    // and blocks the process. The default sink is the process stderr, so the
    // model's logs stay visible to the operator (the conformance stub writes its
    // banner to stdout, which is handled the same way).
    attachStreamLog(child.stdout, this.logSink);
    attachStreamLog(child.stderr, this.logSink);

    const port = await this.discoverPort(child);
    if (!port) {
      await this.killChild();
      throw new Error(`model server did not report a listening port within ${this.readyTimeoutMs}ms`);
    }
    this.port = port;
    this.base = `http://${this.host}:${this.port}`;
    if (!(await this.probeReady())) {
      await this.killChild();
      throw new Error(`model server did not become ready at ${this.base} within ${this.readyTimeoutMs}ms`);
    }
    this.state = "ready";
    this.detail = undefined;
  }

  /** Find the port the server bound: a fixed port if requested, else parse the
   *  listen URL the server prints. The real `llama-server` prints
   *  "listening on http://host:port" to STDERR; the conformance stub prints
   *  "Server listening at http://host:port" to STDOUT — so scan BOTH streams
   *  (a single combined buffer, to catch the address split across a chunk
   *  boundary). We match the listen URL specifically (not a bare ":port" token)
   *  so an unrelated log line can never masquerade as the port, and a server
   *  that never prints one fails closed (a timeout → degraded, not a guess). */
  private async discoverPort(child: ChildProcess): Promise<number> {
    if (this.requestedPort !== 0) return this.requestedPort;
    // child.stdout / child.stderr are `Readable | null`; keep the readable ones.
    const streams = ([child.stdout, child.stderr] as Array<ReadableStreamLike | null>).filter(
      (s): s is ReadableStreamLike => s !== null,
    );
    let buffer = "";
    let resolved = false;
    return await new Promise((resolve) => {
      const finish = (port: number) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        for (const s of streams) {
          s.off("data", onData);
          s.off("close", onClose);
          s.off("error", onError);
        }
        resolve(port);
      };
      const onData = (d: unknown) => {
        buffer += Buffer.isBuffer(d) ? d.toString("utf8") : String(d);
        const m = LISTEN_URL_PORT_RE.exec(buffer);
        if (m) finish(Number(m[1]));
      };
      const onClose = () => finish(0);
      const onError = () => finish(0);
      const timer = setTimeout(() => finish(0), this.readyTimeoutMs);
      for (const s of streams) {
        s.on("data", onData);
        s.on("close", onClose);
        s.on("error", onError);
      }
    });
  }

  private async probeReady(): Promise<boolean> {
    const deadline = this.now() + this.readyTimeoutMs;
    while (this.now() < deadline) {
      try {
        const res = await this.fetchImpl(`${this.base}/health`);
        if (res.ok) return true;
      } catch {
        // not ready yet
      }
      await sleep(100);
    }
    return false;
  }

  isReady(): boolean {
    return this.state === "ready";
  }
  status(): EngineStatus {
    return {
      status: this.state,
      model: this.model,
      ...(this.port ? { port: this.port } : {}),
      ...(this.detail ? { error: this.detail } : {}),
    };
  }
  record(invocation: ModelUsage): AuditEvent {
    return recordUsage(this.audit, this.provider, invocation);
  }

  async invoke(request: ModelRequest): Promise<ModelResult> {
    if (!this.isReady()) await this.start();
    if (!this.isReady()) throw new Error(`model is not ready: ${this.detail ?? "degraded"}`);
    const started = this.now();
    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      messages: [{ role: "user", content: request.prompt }],
    };
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    const fmt = structuredFormat(request);
    if (fmt !== undefined) body.response_format = fmt;
    try {
      const res = await withTimeout(
        this.fetchImpl(`${this.base}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        this.invokeTimeoutMs,
      );
      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`model server returned ${res.status}: ${text.slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const completion = json.choices?.[0]?.message?.content ?? "";
      const usage = {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
        durationMs: this.now() - started,
      };
      this.record({ ...usage, prompt: request.prompt, completion });
      return { completion, ...usage };
    } catch (err) {
      this.record({
        inputTokens: undefined,
        outputTokens: undefined,
        durationMs: this.now() - started,
        outcome: "error",
        error: (err as Error).message,
      });
      this.state = "degraded";
      this.detail = (err as Error).message;
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.killChild();
    this.state = this.state === "ready" || this.state === "starting" ? "not-started" : this.state;
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already dead */
          }
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    } catch {
      /* already dead */
    }
  }
}

// --- RemoteEngine (SD-04) ---------------------------------------------------

export interface RemoteEngineOptions {
  audit: AuditLogger;
  /** Base URL, e.g. http://model.internal:8080 (must be in allowed_network). */
  endpoint: string;
  model?: string;
  /** Bearer token, resolved from the config's env ref at construction. */
  bearerToken?: string;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  /** Egress gate: the remote endpoint must be declared (VPN-02). */
  guard: NetworkGuard;
  invokeTimeoutMs?: number;
  now?: () => number;
}

/**
 * A remote model endpoint (SD-04's "remote" half). Same interface as the local
 * engine; all egress goes through the NetworkGuard, so a mis-declared endpoint
 * is refused before the dial (VPN-02). No child process.
 */
export class RemoteEngine implements LlmEngine {
  readonly provider = "remote";
  private readonly audit: AuditLogger;
  private readonly base: string;
  private readonly model?: string;
  private readonly bearerToken?: string;
  private readonly fetchImpl: FetchLike;
  private readonly guard: NetworkGuard;
  private readonly invokeTimeoutMs: number;
  private readonly now: () => number;
  private state: EngineState = "not-started";
  private detail: string | undefined;

  constructor(options: RemoteEngineOptions) {
    this.audit = options.audit;
    this.base = options.endpoint.replace(/\/$/, "");
    this.model = options.model;
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.guard = options.guard;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 60000;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.state === "ready") return;
    this.state = "starting";
    // Guard the endpoint before dialing (VPN-02).
    this.guard.assert(`${this.base}/v1/chat/completions`);
    try {
      const res = await this.fetchImpl(`${this.base}/health`);
      if (res.ok) this.state = "ready";
      else throw new Error(`remote model /health returned ${res.status}`);
    } catch (err) {
      this.state = "degraded";
      this.detail = (err as Error).message;
      throw err;
    }
  }
  isReady(): boolean {
    return this.state === "ready";
  }
  status(): EngineStatus {
    return { status: this.state, model: this.model, ...(this.detail ? { error: this.detail } : {}) };
  }
  record(invocation: ModelUsage): AuditEvent {
    return recordUsage(this.audit, this.provider, invocation);
  }
  async invoke(request: ModelRequest): Promise<ModelResult> {
    if (!this.isReady()) await this.start();
    if (!this.isReady()) throw new Error(`remote model is not ready: ${this.detail ?? "degraded"}`);
    const started = this.now();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      messages: [{ role: "user", content: request.prompt }],
    };
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    const fmt = structuredFormat(request);
    if (fmt !== undefined) body.response_format = fmt;
    try {
      const res = await withTimeout(
        this.fetchImpl(`${this.base}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
        this.invokeTimeoutMs,
      );
      if (!res.ok) throw new Error(`remote model returned ${res.status}`);
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const completion = json.choices?.[0]?.message?.content ?? "";
      const usage = {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
        durationMs: this.now() - started,
      };
      this.record({ ...usage, prompt: request.prompt, completion });
      return { completion, ...usage };
    } catch (err) {
      this.record({ durationMs: this.now() - started, outcome: "error", error: (err as Error).message });
      this.state = "degraded";
      this.detail = (err as Error).message;
      throw err;
    }
  }
  async close(): Promise<void> {}
}

// --- StubEngine (tests / no model) ------------------------------------------

export interface StubEngineOptions {
  audit: AuditLogger;
  /** Completion returned by invoke. Default a canned plan. */
  completion?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * A deterministic in-process engine for tests and for CI runs with no model/GPU.
 * The whole standalone path (loop, API, lifecycle) is testable against it.
 */
export class StubEngine implements LlmEngine {
  readonly provider = "stub";
  private readonly audit: AuditLogger;
  private readonly completion: string;
  private readonly inputTokens: number;
  private readonly outputTokens: number;
  private state: EngineState = "not-started";
  private detail: string | undefined;

  constructor(options: StubEngineOptions) {
    this.audit = options.audit;
    this.completion = options.completion ?? JSON.stringify({
      goal: "stub",
      gather: [{ id: "stub", server: "stub", tool: "stub_tool", args: {} }],
    });
    this.inputTokens = options.inputTokens ?? 1;
    this.outputTokens = options.outputTokens ?? 1;
  }

  /** Force a degraded state (test: dead-model path). */
  fail(detail: string): void {
    this.state = "degraded";
    this.detail = detail;
  }

  async start(): Promise<void> {
    if (this.state === "degraded") return;
    this.state = "ready";
  }
  isReady(): boolean {
    return this.state === "ready";
  }
  status(): EngineStatus {
    return { status: this.state, model: "stub", ...(this.detail ? { error: this.detail } : {}) };
  }
  record(invocation: ModelUsage): AuditEvent {
    return recordUsage(this.audit, this.provider, invocation);
  }
  async invoke(_request: ModelRequest): Promise<ModelResult> {
    if (!this.isReady()) await this.start();
    if (!this.isReady()) throw new Error(`stub model is not ready: ${this.detail ?? "degraded"}`);
    const result: ModelResult = {
      completion: this.completion,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      durationMs: 0,
    };
    this.record({
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      durationMs: 0,
      completion: this.completion,
    });
    return result;
  }
  async close(): Promise<void> {}
}

// --- factory ----------------------------------------------------------------

export interface CreateLlmEngineOptions {
  /** Egress gate for a remote endpoint (VPN-02). */
  guard?: NetworkGuard;
  /** Resolved bearer token for a remote endpoint (from ${ENV_REF}). */
  bearerToken?: string;
  /** Cap on the local model's CPU threads (§4.5); undefined = uncapped. */
  maxThreads?: number;
  /** Injectable for tests: a fake fetch handed to a real engine. */
  fetchImpl?: FetchLike;
  /** Injectable for tests: a fake spawn handed to the local engine. */
  spawnFactory?: LlamaCppEngineOptions["spawnFactory"];
}

/**
 * Build the engine for a config's LLM provider. `host` → the Phase 1 engine.
 * `local` → a llama.cpp-backed engine (needs model + model_path). `remote` → a
 * remote endpoint (needs endpoint; guarded by NetworkGuard). All are constructed
 * lazily-friendly: the constructor is cheap; `start()` does the work.
 */
export function createLlmEngine(
  llm: LlmConfig,
  audit: AuditLogger,
  options: CreateLlmEngineOptions = {},
): LlmEngine {
  if (llm.provider === "host") return new HostLlmEngine(audit);
  if (llm.provider === "local") {
    if (llm.model === undefined || llm.model_path === undefined) {
      throw new Error('llm.provider "local" requires both "model" and "model_path" (SD-02)');
    }
    const engine = llm.engine;
    return new LlamaCppEngine({
      audit,
      model: llm.model,
      modelPath: llm.model_path,
      command: engine?.command,
      host: engine?.host,
      port: engine?.port,
      maxThreads: options.maxThreads,
      spawnFactory: options.spawnFactory,
      fetchImpl: options.fetchImpl,
    });
  }
  // provider === "remote"
  if (llm.endpoint === undefined) {
    throw new Error('llm.provider "remote" requires "endpoint" (SD-04)');
  }
  if (!options.guard) {
    throw new Error('llm.provider "remote" requires an egress guard (NetworkGuard)');
  }
  return new RemoteEngine({
    audit,
    endpoint: llm.endpoint,
    model: llm.model,
    bearerToken: options.bearerToken,
    fetchImpl: options.fetchImpl,
    guard: options.guard,
  });
}

// --- utilities --------------------------------------------------------------

/** The subset of a piped child stream the engine needs (for test fakes). */
type ReadableStreamLike = {
  on: (ev: string, cb: (...a: unknown[]) => void) => unknown;
  off: (ev: string, cb: (...a: unknown[]) => void) => unknown;
};

/**
 * Keep a piped child stream from blocking the model process. Once the port is
 * discovered the stream is still open for the child's whole life, so a
 * long-running model's logs must be read (or drained) continuously; otherwise
 * the OS pipe buffer fills and the model blocks on a write. Forward each chunk
 * to the log sink (the process stderr by default) — this both drains the pipe
 * and keeps the model's output visible.
 */
function attachStreamLog(stream: ReadableStreamLike | null | undefined, sink: (chunk: string) => void): void {
  if (stream === null || stream === undefined) return;
  stream.on("data", (d: unknown) => sink(Buffer.isBuffer(d) ? d.toString("utf8") : String(d)));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
