import path from "node:path";
import {
  createSandy,
  type Sandy,
  type SandyDeps,
} from "../sandy.js";
import type { ProgressEvent } from "../orchestrator/orchestrator.js";

/**
 * A live plugin session: one {@link Sandy} bound to one `sandy.json`, plus a
 * progress collector. A host (Claude Code / Codex) makes many tool calls in a
 * row, so the plugin reuses one Sandy per config instead of re-running the
 * startup sequence (sandbox detection, every MCP connect) per call.
 */
export interface PluginSession {
  sandy: Sandy;
  /** The resolved config path this session is bound to. */
  configPath: string;
  progress: ProgressCollector;
}

/**
 * Options for starting a plugin. Mirrors the CLI/composition options minus the
 * config path and the progress sink (progress is always collected in-band by
 * the plugin and returned on the result, since a host usually only surfaces
 * the final tool result, not a streamed terminal).
 */
export interface SandyPluginOptions extends Omit<SandyDeps, "sandyPath" | "onProgress"> {
  env?: SandyDeps["env"];
}

/**
 * Collects streaming progress events (Q4) as short strings. The plugin resets
 * it before a run and drains it after, so `sandy.gather` / `sandy.report` can
 * return the events in-band. Safe because a host invokes tools sequentially.
 */
export class ProgressCollector {
  private events: string[] = [];

  /** The sink to hand to the orchestrator. */
  readonly sink: (e: ProgressEvent) => void = (e) => {
    this.events.push(describeProgress(e));
  };

  reset(): void {
    this.events = [];
  }

  /** Take and clear the collected events. */
  drain(): string[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

function describeProgress(e: ProgressEvent): string {
  switch (e.type) {
    case "task-started":
      return `${e.task}: ${e.server}/${e.tool}`;
    case "task-succeeded":
      return `${e.task} ok (${e.durationMs}ms)`;
    case "task-failed":
      return `${e.task} failed: ${e.error}`;
    case "report-writing":
      return `writing report → ${e.path}`;
      case "write-approved":
        return `write ${e.task} → ${e.server}/${e.tool} approved by ${e.approver}`;
      case "write-denied":
        return `write ${e.task} denied: ${e.reason}`;
      case "write-succeeded":
        return `write ${e.task} ok (${e.durationMs}ms)`;
      case "write-failed":
        return `write ${e.task} failed: ${e.error}`;
      case "done":
        return `done: ${e.claims} claim(s), ${e.gaps} gap(s)`;
      case "parse-started":
        return `planning (up to ${e.maxAttempts} attempt(s))`;
      case "parse-attempt-failed":
        return `plan attempt ${e.attempt} rejected: ${e.error}`;
      case "parse-fallback":
        return `plan: ${e.reason}`;
      case "replan-started":
        return `replanning (round ${e.round}/${e.maxRounds})`;
      case "replan-attempt-failed":
        return `replan round ${e.round} attempt ${e.attempt} rejected: ${e.error}`;
      case "replan-stopped":
        return `replan stopped (round ${e.round}): ${e.reason}`;
      case "narrating":
        return "narrating";
  }
}

/**
 * Cache of {@link PluginSession}s keyed by resolved config path. Lets a host
 * call many tools without restarting Sandy. Tests pass `new Map()` semantics
 * implicitly by creating a fresh plugin per test.
 */
export class SessionCache {
  // The in-flight promise itself is the cache value: reserving the slot
  // synchronously (before any await) is what closes the get() race — two
  // concurrent callers for the same config path both see the same promise and
  // Sandy is constructed exactly once.
  private readonly sessions = new Map<string, Promise<PluginSession>>();

  constructor(private readonly options: SandyPluginOptions) {}

  get size(): number {
    return this.sessions.size;
  }

  get(configPath: string): Promise<PluginSession> {
    const resolved = path.resolve(configPath);
    const existing = this.sessions.get(resolved);
    if (existing) return existing;

    const progress = new ProgressCollector();
    const sessionPromise = createSandy({
      ...this.options,
      sandyPath: resolved,
      onProgress: progress.sink,
    }).then(
      (sandy) => ({ sandy, configPath: resolved, progress }),
      (err) => {
        // Don't leave a permanently-broken entry cached — let a later call
        // retry construction from scratch.
        this.sessions.delete(resolved);
        throw err;
      },
    );
    this.sessions.set(resolved, sessionPromise);
    return sessionPromise;
  }

  async closeAll(): Promise<void> {
    const pending = [...this.sessions.values()];
    this.sessions.clear();
    const sessions = await Promise.allSettled(pending);
    await Promise.all(
      sessions
        .filter((r): r is PromiseFulfilledResult<PluginSession> => r.status === "fulfilled")
        .map((r) => r.value.sandy.close()),
    );
  }
}
