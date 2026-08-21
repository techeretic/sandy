import type { LlmConfig } from "./config/schema.js";
import { logModelInvocation, type AuditEvent, type AuditLogger } from "./audit/logger.js";

/**
 * The LLM Engine — the reasoning layer (PRD §7: "either the bundled local model
 * (standalone) or the host LLM (plugin mode)").
 *
 * Two jobs, cleanly split:
 *
 *  - **Record (AU-01).** Every model invocation lands in the audit log with its
 *    token counts. In plugin mode the HOST is the engine, so the host reports
 *    its usage back (via the `sandy.model.usage` tool) and Sandy records it. In
 *    standalone mode a bundled engine records its own invocations. Either way the
 *    audit trail is uniform.
 *  - **Invoke (the Phase 2 seam).** Actually run a model. Only a bundled/remote
 *    engine does this. The interface is fixed NOW (SD-02/SD-04) so a Phase 2
 *    bundled 4–8B model drops in without rework to the orchestrator/report
 *    pipeline.
 *
 * Fail-closed: `createLlmEngine` only supports `provider: "host"` in Phase 1.
 * `local`/`remote` are Phase 2 (SD-02/SD-04) and refuse to start with an
 * explicit message rather than silently pretending to reason.
 */
export interface ModelUsage {
  /** Model provider label, e.g. "host:claude-code". Defaults to the engine's. */
  provider?: string;
  /** Model name/id, when the host exposes it. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  outcome?: "ok" | "error";
  error?: string;
  /**
   * Prompt / completion. These are *payloads*: they are only persisted when
   * payload logging is opted in (AU-02), never by default.
   */
  prompt?: string;
  completion?: string;
}

/** A request to a (bundled/remote) model. */
export interface ModelRequest {
  prompt: string;
  model?: string;
  /** Maximum tokens to generate. */
  maxTokens?: number;
}

/** The result of a model invocation. */
export interface ModelResult {
  completion: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

/**
 * The reasoning-layer seam. Implement it to plug in a model backend; the
 * orchestrator/report pipeline calls it without knowing which engine is behind
 * it. `HostLlmEngine` is the Phase 1 (plugin mode) implementation.
 */
export interface LlmEngine {
  /** Stable provider label, e.g. "host" or "local:llama.cpp". */
  readonly provider: string;
  /**
   * Record a model invocation (token counts) into the audit log (AU-01).
   * Prompt/completion, if present, are recorded as an opt-in payload (AU-02).
   * Returns the stored audit event (the caller can use its `seq` as a receipt).
   */
  record(invocation: ModelUsage): AuditEvent;
  /**
   * Run the model on a prompt. The Phase 1 host engine does NOT implement this —
   * the host reasons outside Sandy — so it throws a clear error. A bundled
   * (Phase 2) engine implements it and should `record()` the invocation itself.
   */
  invoke(request: ModelRequest): Promise<ModelResult>;
}

/**
 * Phase 1 (plugin mode) engine: the HOST LLM is the engine. It never invokes a
 * model itself; it only records the usage the host reports, so model invocations
 * show up in the audit trail (AU-01).
 */
export class HostLlmEngine implements LlmEngine {
  readonly provider = "host";

  constructor(private readonly audit: AuditLogger) {}

  record(invocation: ModelUsage): AuditEvent {
    const { prompt, completion, provider, model, inputTokens, outputTokens, durationMs, outcome, error } =
      invocation;
    const details = {
      provider: provider ?? this.provider,
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
    return logModelInvocation(this.audit, details, opts);
  }

  async invoke(_request: ModelRequest): Promise<ModelResult> {
    throw new Error(
      "no bundled model in this build: in plugin mode the HOST LLM is the engine (PL-03) — " +
        "Sandy does not invoke a model itself. Report host usage via record() (the sandy.model.usage tool).",
    );
  }
}

/**
 * Build the engine for a config's LLM provider. Phase 1 supports only `host`.
 * `local`/`remote` are Phase 2 (SD-02/SD-04) and fail closed with an explicit
 * message (never silently ignored).
 */
export function createLlmEngine(llm: LlmConfig, audit: AuditLogger): LlmEngine {
  if (llm.provider === "host") return new HostLlmEngine(audit);
  if (llm.provider === "local") {
    throw new Error(
      `llm.provider "local" (bundled model, SD-02) is a Phase 2 feature — not available in this build. ` +
        `Use "host" (plugin mode) for now.`,
    );
  }
  // provider === "remote"
  throw new Error(
    `llm.provider "remote" (configurable model backend, SD-04) is a Phase 2 feature — not available in this build. ` +
      `Use "host" (plugin mode) for now.`,
  );
}
