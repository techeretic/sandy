import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Sandy, SandyCheckReport } from "../sandy.js";
import {
  orchestratorRequestSchema,
  toOrchestratorRequest,
  type OrchestratorRequestInput,
} from "../orchestrator/request.js";
import type { OrchestratorResult, ProgressEvent } from "../orchestrator/orchestrator.js";
import type { LoopResult } from "./loop.js";
import { captureTranscript } from "../audit/transcript.js";

/**
 * The loopback-only local API (SD-03, design §5) — a plain `node:http` server
 * (no framework dep) wrapped over the composed {@link Sandy}. It is the
 * REST surface for a UI / other local tools; the CLI stays the primary local
 * interface.
 *
 * Security invariants (not preferences):
 *  - **Loopback-only.** Binds to `127.0.0.1` (or a configurable loopback host);
 *    binding off-loopback is refused fail-closed. The service is per-user (Q5)
 *    and must never become a network-exposed endpoint — this closes the ingress
 *    side (egress was already guaranteed by the NetworkGuard).
 *  - **No auth in v2** because it is loopback-only and single-user. A later
 *    need is a config-gated addition, not a default.
 *  - **One definition of a legal request.** `POST /run` bodies are validated by
 *    the same `orchestratorRequestSchema` the CLI and plugin use.
 *
 * The job store is **bounded** (design §5): a fixed max pending + a bounded
 * completed retention (keep the most recent N, evict oldest), so a long-lived
 * process doesn't grow without limit. `GET /jobs/:id` on an evicted id is a
 * clean `404`, not a crash.
 *
 * Jobs run **serially** through one worker: the composed `Sandy` has a single
 * progress sink, and (like the plugin's `ProgressCollector`) progress is only
 * unambiguous when one job runs at a time. This mirrors the plugin's sequential
 * assumption and keeps SSE routing exact.
 */

export interface LocalApiOptions {
  /** Loopback host to bind. Default 127.0.0.1. Off-loopback is refused. */
  host?: string;
  /** Port to bind. Default 0 = pick a free one. */
  port?: number;
  /** Max jobs allowed to sit in the pending (queued) state. Default 50. */
  maxPending?: number;
  /** How many finished jobs to retain (evict oldest beyond this). Default 100. */
  maxCompleted?: number;
  /** Readable body cap in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** A fail-closed error: the API was asked to bind off-loopback. */
export class LoopbackBindError extends Error {}

export type JobKind = "run" | "ask";
export type JobStatus = "queued" | "running" | "done" | "error";

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** The (validated) request that produced the job. */
  input: unknown;
  /** The result, once done (OrchestratorResult or LoopResult). */
  result?: OrchestratorResult | LoopResult;
  /** The error, when status is "error". */
  error?: string;
  /** In-band progress lines (short, human-readable). */
  progress: string[];
  /** Active SSE subscribers (ServerResponses streaming this job). */
  sse: Set<ServerResponse>;
}

/**
 * A bounded in-memory job registry. Keeps at most `maxCompleted` finished jobs
 * (evicting the oldest); pending/running jobs are never evicted. This is what
 * keeps a long-lived service from growing without limit (design §5).
 */
export class BoundedJobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly order: string[] = [];
  private readonly maxCompleted: number;
  private seq = 0;

  constructor(maxCompleted = 100) {
    this.maxCompleted = Math.max(1, maxCompleted);
  }

  get size(): number {
    return this.jobs.size;
  }

  create(kind: JobKind, input: unknown): Job {
    this.seq += 1;
    const job: Job = {
      id: `job-${this.seq}`,
      kind,
      status: "queued",
      createdAt: Date.now(),
      input,
      progress: [],
      sse: new Set(),
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.evict();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  all(): Job[] {
    return [...this.jobs.values()];
  }

  /** Count of jobs waiting to run. */
  pendingCount(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === "queued") n += 1;
    return n;
  }

  /** The oldest queued job, if any (the serial worker pulls these). */
  nextQueued(): Job | undefined {
    for (const id of this.order) {
      const job = this.jobs.get(id);
      if (job && job.status === "queued") return job;
    }
    return undefined;
  }

  /**
   * Evict the oldest *finished* jobs until the finished count is within
   * `maxCompleted`. Never evicts queued/running jobs. Evicted ids 404 on
   * `GET /jobs/:id`.
   */
  evict(): void {
    const finished = (): Job[] => [...this.jobs.values()].filter((j) => isTerminal(j.status));
    while (finished().length > this.maxCompleted) {
      const oldest = this.order.find((id) => {
        const j = this.jobs.get(id);
        return j && isTerminal(j.status);
      });
      if (oldest === undefined) break;
      const job = this.jobs.get(oldest);
      if (job) for (const res of job.sse) endSse(res, { type: "evicted" });
      this.jobs.delete(oldest);
      const idx = this.order.indexOf(oldest);
      if (idx !== -1) this.order.splice(idx, 1);
    }
  }
}

function isTerminal(status: JobStatus): boolean {
  return status === "done" || status === "error";
}

/** The loopback-only API over a composed {@link Sandy}. */
export class LocalApi {
  private readonly sandy: Sandy;
  private readonly store: BoundedJobStore;
  private readonly maxPending: number;
  private readonly maxBodyBytes: number;
  private readonly host: string;
  private readonly port: number;
  private server: Server | null = null;
  private current: Job | null = null;
  private stopped = false;
  private workerDone: Promise<void> | null = null;

  constructor(sandy: Sandy, options: LocalApiOptions = {}) {
    this.sandy = sandy;
    this.store = new BoundedJobStore(options.maxCompleted ?? 100);
    this.maxPending = Math.max(1, options.maxPending ?? 50);
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    if (!LOOPBACK_HOSTS.has(this.host)) {
      throw new LoopbackBindError(
        `refusing to bind the local API to "${this.host}": the API is loopback-only (127.0.0.1/localhost/::1). It must never be network-exposed.`,
      );
    }
  }

  /** The host the server is bound to (loopback). */
  get boundHost(): string {
    return this.host;
  }

  /** The actual bound port (0 if not yet listening; set after start). */
  get boundPort(): number {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : this.port;
  }

  get jobStore(): BoundedJobStore {
    return this.store;
  }

  /** The composed Sandy this API is wrapped over (read-only). */
  get composed(): Sandy {
    return this.sandy;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => resolve());
    });
    this.server = server;
    this.workerDone = this.worker();
  }

  /** Route a request; an unexpected error is a clean 500, not a crash. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await handleRequest(this, req, res, this.maxBodyBytes);
    } catch (err) {
      if (!res.headersSent) {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }

  /**
   * Enqueue a job. Returns the job, or throws an {@link ApiError} with an HTTP
   * status (400 invalid body, 429 queue full, 405 bad method).
   */
  enqueue(kind: JobKind, body: unknown): Job {
    if (this.stopped) throw new ApiError(503, "service is shutting down");
    if (this.store.pendingCount() >= this.maxPending) {
      throw new ApiError(429, "too many pending jobs; try again shortly");
    }
    const input = this.validate(kind, body);
    return this.store.create(kind, input);
  }

  private validate(kind: JobKind, body: unknown): unknown {
    if (kind === "run") {
      const parsed = orchestratorRequestSchema.safeParse(body ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new ApiError(400, `invalid orchestrator request: ${issues}`);
      }
      return toOrchestratorRequest(parsed.data);
    }
    // kind === "ask"
    const goal = (body as { goal?: unknown } | null)?.goal;
    if (typeof goal !== "string" || goal.trim().length === 0) {
      throw new ApiError(400, "invalid ask body: { \"goal\": \"<non-empty string>\" } is required");
    }
    return { goal: goal.trim() };
  }

  getHealth(): SandyCheckReport {
    return this.sandy.check();
  }

  /**
   * Route one progress event to the currently-running job: record it in-band
   * (on the job) and push it to any SSE subscribers. This is the per-job sink
   * the worker installs on the orchestrator, so the composed Sandy's own sink
   * (none by default, or the CLI's stderr sink) is left untouched.
   */
  route(event: ProgressEvent): void {
    const job = this.current;
    if (!job) return;
    const text = describeProgressEvent(event);
    job.progress.push(text);
    for (const res of job.sse) writeSse(res, { type: "progress", text });
  }

  private async worker(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const job = this.store.nextQueued();
      if (!job) {
        await sleep(5);
        continue;
      }
      this.current = job;
      job.status = "running";
      job.startedAt = Date.now();
      this.sseAll(job, { type: "running" });
      // Redirect the orchestrator's AND the loop's progress to this job
      // (in-band + SSE), then restore the previous sinks when done. One job at
      // a time, so this is safe. This mirrors the plugin's ProgressCollector.
      const previousOrchSink = this.sandy.orchestrator.getProgressSink();
      const previousLoopSink = this.sandy.loop.getProgressSink();
      const jobSink = (e: ProgressEvent) => this.route(e);
      this.sandy.orchestrator.setProgressSink(jobSink);
      this.sandy.loop.setProgressSink(jobSink);
      try {
        const result =
          job.kind === "run"
            ? await this.sandy.run(job.input as ReturnType<typeof toOrchestratorRequest>)
            : await this.sandy.ask((job.input as { goal: string }).goal);
        job.result = result;
        job.status = "done";
        this.sseAll(job, donePayload(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        job.error = message;
        job.status = "error";
        this.sseAll(job, { type: "error", error: message });
      } finally {
        this.sandy.orchestrator.setProgressSink(previousOrchSink);
        this.sandy.loop.setProgressSink(previousLoopSink);
        job.finishedAt = Date.now();
        this.current = null;
        this.store.evict();
        for (const res of job.sse) res.end();
        job.sse.clear();
      }
    }
  }

  private sseAll(job: Job, payload: Record<string, unknown>): void {
    for (const res of job.sse) writeSse(res, payload);
  }

  /** Register an SSE stream for a job. Returns a cleanup function. */
  subscribe(job: Job, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    if (isTerminal(job.status)) {
      // Already finished: replay the progress, then the terminal event.
      for (const line of job.progress) writeSse(res, { type: "progress", text: line });
      writeSse(res, job.status === "done" && job.result ? donePayload(job.result) : { type: "error", error: job.error ?? "job failed" });
      res.end();
      return;
    }
    job.sse.add(res);
    // When the client disconnects, drop the subscription.
    res.on("close", () => job.sse.delete(res));
  }

  /**
   * Graceful stop: stop accepting, stop the worker (letting the in-flight job
   * finish), and release the port. Callers then close the {@link Sandy}.
   */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.workerDone) await this.workerDone;
  }
}

/** A request error carrying an HTTP status code. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// --- HTTP handling -----------------------------------------------------------

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new ApiError(413, `request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new ApiError(400, `request body is not valid JSON: ${(err as Error).message}`);
  }
}

function jobResponse(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    progress: job.progress,
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
}

function donePayload(result: OrchestratorResult | LoopResult): Record<string, unknown> {
  const r = result as OrchestratorResult;
  return { type: "done", claims: r.claims?.length ?? 0, gaps: r.gaps?.length ?? 0 };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res: ServerResponse): void {
  send(res, 404, { error: "not found" });
}

async function handleRequest(
  api: LocalApi,
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean); // e.g. ["jobs","job-1","events"]

  // GET /health
  if (method === "GET" && url.pathname === "/health") {
    send(res, 200, api.getHealth());
    return;
  }

  const composed = api.composed;

  // GET /reports — list written reports in the confined reports dir.
  if (method === "GET" && url.pathname === "/reports") {
    try {
      const entries = await composed.files.list(composed.loaded.reportOutputDir, { recursive: false });
      send(res, 200, { dir: composed.loaded.reportOutputDir, reports: entries });
    } catch {
      send(res, 200, { dir: composed.loaded.reportOutputDir, reports: [] }); // no reports yet
    }
    return;
  }

  // GET /audit — transcript export (AU-03).
  if (method === "GET" && url.pathname === "/audit") {
    send(res, 200, captureTranscript(composed.audit));
    return;
  }

  // POST /run, POST /ask
  if (method === "POST" && (url.pathname === "/run" || url.pathname === "/ask")) {
    const kind: JobKind = url.pathname === "/run" ? "run" : "ask";
    let body: unknown;
    try {
      body = await readJsonBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, err.status, { error: err.message });
        return;
      }
      throw err;
    }
    try {
      const job = api.enqueue(kind, body);
      send(res, 202, { id: job.id, status: job.status });
    } catch (err) {
      if (err instanceof ApiError) send(res, err.status, { error: err.message });
      else send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // GET /jobs/:id  and  GET /jobs/:id/events
  if (method === "GET" && parts[0] === "jobs" && parts[1]) {
    const job = api.jobStore.get(parts[1]);
    if (!job) {
      notFound(res);
      return;
    }
    if (parts[2] === "events") {
      api.subscribe(job, res);
      return;
    }
    if (parts.length === 2) {
      send(res, 200, jobResponse(job));
      return;
    }
  }

  notFound(res);
}

// --- progress + SSE helpers --------------------------------------------------

function describeProgressEvent(e: ProgressEvent): string {
  switch (e.type) {
    case "task-started":
      return `${e.task}: ${e.server}/${e.tool}`;
    case "task-succeeded":
      return `${e.task} ok (${e.durationMs}ms)`;
    case "task-failed":
      return `${e.task} failed: ${e.error}`;
    case "report-writing":
      return `writing report → ${e.path}`;
    case "done":
      return `done: ${e.claims} claim(s), ${e.gaps} gap(s)`;
    case "parse-started":
      return `planning (up to ${e.maxAttempts} attempt(s))`;
    case "parse-attempt-failed":
      return `plan attempt ${e.attempt} rejected: ${e.error}`;
    case "parse-fallback":
      return `plan: ${e.reason}`;
    case "narrating":
      return "narrating";
  }
}

function writeSse(res: ServerResponse, payload: Record<string, unknown>): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function endSse(res: ServerResponse, payload: Record<string, unknown>): void {
  if (res.writableEnded) return;
  writeSse(res, payload);
  res.end();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a loopback-only API over a composed {@link Sandy}. Fails closed if the
 * requested host is not loopback. The caller is responsible for `close()`.
 */
export function createLocalApi(sandy: Sandy, options: LocalApiOptions = {}): LocalApi {
  return new LocalApi(sandy, options);
}
