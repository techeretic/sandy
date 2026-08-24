import path from "node:path";
import type { LlmEngine } from "../engine.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { Claim, Gap, OrchestratorRequest, ProgressEvent } from "../orchestrator/orchestrator.js";
import {
  orchestratorRequestSchema,
  toOrchestratorRequest,
  type OrchestratorRequestInput,
} from "../orchestrator/request.js";
import { renderReport, type ReportFormat } from "../orchestrator/report.js";
import type { AuditLogger } from "../audit/logger.js";
import { captureTranscript, type Transcript } from "../audit/transcript.js";
import type { FileManager } from "../files/file-manager.js";

/**
 * The autonomous reasoning loop (design §2.1) — the one genuinely new behavior
 * in Phase 2. In plugin mode the HOST LLM plans and narrates; in standalone
 * mode the bundled model does, behind the same `LlmEngine` seam, driving the
 * SAME deterministic orchestrator:
 *
 *   goal ──▶ [parse]  ──▶ [run]  ──▶ [narrate]  ──▶ report + transcript
 *
 * Invariants (the ones that make a weak 4–8B model safe):
 *  - **The model proposes, the schema disposes.** A plan is validated against
 *    `orchestratorRequestSchema` AND the legal tool catalog; anything else is a
 *    recorded error/retry, never a silent bad request.
 *  - **Parse is bounded and deterministic.** Retry the error back, up to a small
 *    fixed cap; on exhaustion fall back to a *deterministic* conservative plan
 *    (a single task if the goal names exactly one known tool), else
 *    refuse-and-report with an explicit gap. Never unbounded, never invented.
 *  - **Provenance is unaffected.** Claims come from MCP tool results, exactly as
 *    in plugin mode. The model only plans which tools to call and writes a
 *    clearly-labeled narrative.
 *  - **Every model call is audited** (`model_invocation`, via the engine) and
 *    each parse/narrate step is audited (`standalone_parse`/`standalone_narrate`).
 *  - **A dead model is reported, not a crash.** A failed invoke degrades to the
 *    fallback / no-narrative path; it never takes down the loop.
 */

/** A (server, tool) pair the plan is allowed to reference. */
export interface ToolRef {
  server: string;
  tool: string;
}

export interface AutonomousLoopOptions {
  engine: LlmEngine;
  orchestrator: Orchestrator;
  audit: AuditLogger;
  /** Confined file manager (used to (re)write the report, confirmed). */
  files: FileManager;
  /** Absolute directory reports are written to. */
  reportDir: string;
  /** Report format (issue #14). Default "markdown"; must match the orchestrator. */
  reportFormat?: ReportFormat;
  /** The legal tool catalog (from the manifest's allowed_tools). */
  tools: readonly ToolRef[];
  /** Progress sink (Q4). */
  onProgress?: (event: ProgressEvent) => void;
  /** Max parse attempts, including the first. Default 3. */
  maxParseAttempts?: number;
  /** Whether to produce a model narrative. Default true. */
  narrative?: boolean;
}

export interface LoopResult {
  goal: string;
  claims: Claim[];
  gaps: Gap[];
  reportPath?: string;
  reportContent?: string;
  transcript: Transcript;
  /** How the plan was produced (model / deterministic fallback / refused). */
  plan: {
    source: "model" | "fallback" | "refused";
    attempts: number;
    reason?: string;
  };
  /** The model narrative (clearly labeled in the report), when narrate ran. */
  narrative?: {
    text: string;
    provider: string;
    inputTokens?: number;
    outputTokens?: number;
  };
  /** The plan that was executed (absent when refused). */
  request?: OrchestratorRequest;
}

/**
 * `ask` was invoked against an engine that cannot invoke a model (the Phase 1
 * host engine). Fail closed with a clear error instead of silently degrading:
 * in plugin mode the host LLM plans directly (PL-03).
 */
export class NoModelEngineError extends Error {}

type ParseResult =
  | { kind: "ok"; request: OrchestratorRequestInput; attempts: number }
  | { kind: "fallback"; request: OrchestratorRequestInput; attempts: number; reason: string }
  | { kind: "refused"; attempts: number; reason: string };

/**
 * JSON-schema constraint for the parse step (the structured-output knob, design
 * open #6). Best-effort: backends that can't honor it still work — the loop
 * validates the output itself regardless.
 */
const REQUEST_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    goal: { type: "string" },
    gather: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          server: { type: "string" },
          tool: { type: "string" },
          args: { type: "object" },
          description: { type: "string" },
        },
        required: ["id", "server", "tool"],
      },
    },
    report: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        file: { type: "string" },
      },
    },
  },
  required: ["goal", "gather"],
} as const;

export class AutonomousLoop {
  private readonly engine: LlmEngine;
  private readonly orchestrator: Orchestrator;
  private readonly audit: AuditLogger;
  private readonly files: FileManager;
  private readonly reportDir: string;
  private readonly reportFormat: ReportFormat;
  private readonly tools: readonly ToolRef[];
  /** Swappable (see {@link setProgressSink}) so a service's job worker can
   *  redirect per-job progress in-band. */
  private onProgress: (event: ProgressEvent) => void;
  private readonly maxAttempts: number;
  private readonly narrateEnabled: boolean;

  constructor(options: AutonomousLoopOptions) {
    this.engine = options.engine;
    this.orchestrator = options.orchestrator;
    this.audit = options.audit;
    this.files = options.files;
    this.reportDir = options.reportDir;
    this.reportFormat = options.reportFormat ?? "markdown";
    this.tools = options.tools;
    this.onProgress = options.onProgress ?? (() => {});
    this.maxAttempts = Math.max(1, options.maxParseAttempts ?? 3);
    this.narrateEnabled = options.narrative ?? true;
  }

  /** The current progress sink (Q4). */
  getProgressSink(): (event: ProgressEvent) => void {
    return this.onProgress;
  }

  /** Swap the progress sink (a service's job worker redirects per-job progress). */
  setProgressSink(sink: (event: ProgressEvent) => void): void {
    this.onProgress = sink;
  }

  /** The legal tool catalog, as `server/tool` strings (for prompts). */
  private get toolList(): string {
    return this.tools.map((t) => `${t.server}/${t.tool}`).join("\n");
  }

  async run(goal: string): Promise<LoopResult> {
    // Fail closed if the engine delegates reasoning to the host (plugin mode):
    // there is no bundled model to plan with, and silently degrading to the
    // deterministic fallback would mask a mode mismatch (the host reasons
    // directly, PL-03).
    if (this.engine.provider === "host") {
      throw new NoModelEngineError(
        "the standalone ask loop needs a bundled/remote model, but the configured engine is the host (plugin mode). " +
          "In plugin mode the host LLM plans and calls the sandy.* tools directly; `sandy ask` is a standalone-mode verb.",
      );
    }
    this.onProgress({ type: "parse-started", maxAttempts: this.maxAttempts });
    const parsed = await this.parse(goal);

    // Refuse-and-report: no legal single-task plan, so an explicit gap is the
    // result. Never invent an unvalidated plan.
    if (parsed.kind === "refused") {
      const gap: Gap = {
        task: "plan",
        server: "sandy",
        tool: "derive-plan",
        reason: "call-failed",
        detail: parsed.reason,
      };
      return {
        goal,
        claims: [],
        gaps: [gap],
        transcript: captureTranscript(this.audit),
        plan: { source: "refused", attempts: parsed.attempts, reason: parsed.reason },
      };
    }

    const request = toOrchestratorRequest(parsed.request);
    const result = await this.orchestrator.run(request);

    const plan: LoopResult["plan"] =
      parsed.kind === "fallback"
        ? { source: "fallback", attempts: parsed.attempts, reason: parsed.reason }
        : { source: "model", attempts: parsed.attempts };

    const loopResult: LoopResult = {
      goal,
      claims: result.claims,
      gaps: result.gaps,
      reportPath: result.reportPath,
      reportContent: result.reportContent,
      transcript: result.transcript,
      plan,
      request,
    };

    // Narrate (optional): a clearly-labeled model summary of the claims, re-
    // rendered into the report's Summary slot. Degrades gracefully on a dead
    // model — the deterministic report already written stands.
    if (this.narrateEnabled && result.reportPath && result.reportContent) {
      const title = request.report?.title ?? goal;
      const narrated = await this.narrate(goal, title, result.claims, result.gaps, result.reportPath);
      if (narrated) {
        loopResult.narrative = narrated.narrative;
        loopResult.reportContent = narrated.content;
      }
    }

    loopResult.transcript = captureTranscript(this.audit);
    return loopResult;
  }

  // --- parse ---------------------------------------------------------------

  private async parse(goal: string): Promise<ParseResult> {
    let lastError = "";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const prompt = buildParsePrompt(goal, this.tools, attempt === 1 ? undefined : lastError);
      try {
        const res = await this.engine.invoke({
          prompt,
          responseFormat: "json",
          jsonSchema: REQUEST_JSON_SCHEMA,
          maxTokens: 1024,
        });
        const obj = extractJsonObject(res.completion);
        if (obj === null) {
          lastError = "the model did not return valid JSON";
          this.recordParse(goal, attempt, "parse-error", lastError);
          continue;
        }
        const checked = this.validatePlan(obj);
        if (!checked.ok) {
          lastError = checked.error;
          this.recordParse(goal, attempt, "invalid-plan", lastError);
          continue;
        }
        const request = this.normalize(checked.data, goal);
        this.recordParse(goal, attempt, "ok");
        this.audit.append("standalone_plan", { source: "model", attempts: attempt });
        return { kind: "ok", request, attempts: attempt };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.recordParse(goal, attempt, "parse-error", lastError);
      }
    }
    return this.fallback(goal, lastError);
  }

  private recordParse(goal: string, attempt: number, outcome: string, error?: string): void {
    this.audit.append("standalone_parse", {
      goal,
      attempt,
      maxAttempts: this.maxAttempts,
      outcome,
      ...(error !== undefined ? { error } : {}),
    });
    if (outcome !== "ok") {
      this.onProgress({ type: "parse-attempt-failed", attempt, error: error ?? "invalid plan" });
    }
  }

  /** Validate a raw model plan against the schema AND the legal tool catalog. */
  private validatePlan(
    obj: unknown,
  ): { ok: true; data: OrchestratorRequestInput } | { ok: false; error: string } {
    const parsed = orchestratorRequestSchema.safeParse(obj);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, error: `plan failed validation: ${issues}` };
    }
    const legal = new Map<string, string[]>();
    for (const t of this.tools) {
      const list = legal.get(t.server) ?? [];
      list.push(t.tool);
      legal.set(t.server, list);
    }
    for (const task of parsed.data.gather) {
      const toolsForServer = legal.get(task.server);
      if (toolsForServer === undefined) {
        const servers = [...legal.keys()].join(", ") || "none";
        return { ok: false, error: `unknown server "${task.server}" (legal servers: ${servers})` };
      }
      if (!toolsForServer.includes(task.tool)) {
        return {
          ok: false,
          error: `tool "${task.tool}" is not allowed on server "${task.server}" (legal tools: ${toolsForServer.join(", ")})`,
        };
      }
    }
    return { ok: true, data: parsed.data };
  }

  /**
   * Normalize a validated plan: pin the goal to the user's verbatim text, drop
   * any model-supplied summary (narrate is the single narrative source), and
   * guarantee a report (the loop's job is gather → report).
   */
  private normalize(data: OrchestratorRequestInput, goal: string): OrchestratorRequestInput {
    const report: { title?: string; file?: string } = {};
    if (data.report?.title) report.title = data.report.title;
    if (data.report?.file) report.file = data.report.file;
    return { goal, gather: data.gather, report };
  }

  /**
   * Deterministic, conservative fallback (design §2.1): if the goal names
   * exactly one known tool, plan that single task; otherwise refuse-and-report.
   * This is a *rule*, not a guess — it never invents a plan.
   */
  private fallback(goal: string, lastError: string): ParseResult {
    const named = namedTools(goal, this.tools);
    if (named.length === 1) {
      const t = named[0]!;
      const request: OrchestratorRequestInput = {
        goal,
        gather: [
          {
            id: "fallback",
            server: t.server,
            tool: t.tool,
            args: {},
            description: "deterministic fallback: the goal names this tool",
          },
        ],
        report: { title: goal },
      };
      const reason = `goal names a single known tool (${t.server}/${t.tool})`;
      this.audit.append("standalone_plan", {
        source: "fallback",
        attempts: this.maxAttempts,
        reason,
      });
      this.onProgress({ type: "parse-fallback", reason });
      return { kind: "fallback", request, attempts: this.maxAttempts, reason };
    }

    const reason =
      named.length === 0
        ? `could not derive a plan after ${this.maxAttempts} attempt(s): the goal names no single known tool`
        : `could not derive a plan after ${this.maxAttempts} attempt(s): the goal names ${named.length} known tools, so no safe single-task fallback`;
    this.audit.append("standalone_plan", { source: "refused", attempts: this.maxAttempts, reason });
    this.onProgress({ type: "parse-fallback", reason });
    return { kind: "refused", attempts: this.maxAttempts, reason };
  }

  // --- narrate -------------------------------------------------------------

  /**
   * Produce a clearly-labeled model summary of the claims and re-render it into
   * the report's Summary slot. On any failure the deterministic report stands
   * (a dead model is reported, not a crash). Returns null when no narrative is
   * produced (so the caller keeps the deterministic report).
   */
  private async narrate(
    goal: string,
    title: string,
    claims: Claim[],
    gaps: Gap[],
    reportPath: string,
  ): Promise<{ narrative: NonNullable<LoopResult["narrative"]>; content: string } | null> {
    this.onProgress({ type: "narrating" });
    let completion: string;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      const res = await this.engine.invoke({
        prompt: buildNarratePrompt(goal, claims, gaps),
        maxTokens: 512,
      });
      completion = res.completion.trim();
      inputTokens = res.inputTokens;
      outputTokens = res.outputTokens;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.audit.append("standalone_narrate", { outcome: "error", error });
      return null;
    }
    if (completion.length === 0) {
      this.audit.append("standalone_narrate", { outcome: "skipped", reason: "empty narrative" });
      return null;
    }

    // Re-render in the configured format (issue #14): the narrative fills the
    // Summary slot, but the format matches what the orchestrator wrote, so the
    // re-written report is the same kind of file.
    const content = renderReport(this.reportFormat, {
      goal,
      title,
      claims,
      gaps,
      generatedAt: new Date().toISOString(),
      summary: completion,
    });
    await this.files.write(reportPath, content, { confirmed: true });
    this.audit.append("standalone_narrate", {
      outcome: "ok",
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    });
    return {
      narrative: {
        text: completion,
        provider: this.engine.provider,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      },
      content,
    };
  }
}

// --- prompt builders + helpers ---------------------------------------------

function buildParsePrompt(goal: string, tools: readonly ToolRef[], priorError?: string): string {
  const toolList = tools.map((t) => `${t.server}/${t.tool}`).join("\n");
  let prompt =
    `You are the planning step of an offline report assistant.\n` +
    `Turn the user's goal into a data-gathering plan using ONLY the tools listed below.\n\n` +
    `GOAL:\n"""\n${goal}\n"""\n\n` +
    `TOOLS YOU MAY CALL (the only legal "server" and "tool" values):\n${toolList}\n\n` +
    `Respond with ONLY a JSON object (no prose, no markdown fences) of exactly this shape:\n` +
    `{"goal":"<the user's goal, verbatim>","gather":[{"id":"<short-stable-id>","server":"<server>","tool":"<tool>","args":{}}],"report":{"title":"<report title>"}}\n\n` +
    `Rules:\n` +
    `- "server" and "tool" MUST come from the TOOLS list above; never invent them.\n` +
    `- "gather" must contain at least one task.\n` +
    `- "args" must be a JSON object (use {} if the tool needs no arguments).\n` +
    `- Only include tools that clearly help with the goal.\n`;
  if (priorError) {
    prompt += `\nYour previous attempt was rejected:\n${priorError}\n\nFix it and respond with ONLY the JSON object.\n`;
  }
  return prompt;
}

function buildNarratePrompt(goal: string, claims: Claim[], gaps: Gap[]): string {
  const claimsText =
    claims.map((c) => `- [${c.ref}] (${c.source.server}/${c.source.tool}) ${c.text}`).join("\n") ||
    "(no claims)";
  const gapsText =
    gaps.map((g) => `- ${g.server}/${g.tool} (task ${g.task}): ${g.reason} — ${g.detail}`).join("\n") ||
    "(none)";
  return (
    `Write a concise, factual summary (2-4 sentences) of this report for the user.\n\n` +
    `GOAL: ${goal}\n\n` +
    `CLAIMS (provenance-tracked findings):\n${claimsText}\n\n` +
    `GAPS (explicit holes — do not paper over them):\n${gapsText}\n\n` +
    `Rules:\n` +
    `- Summarize ONLY what the claims support; do not invent facts, numbers, or sources.\n` +
    `- If there are gaps, note them briefly.\n` +
    `- If there are no claims, say the data was unavailable and why (from the gaps).\n` +
    `- Plain prose only, no markdown.\n`
  );
}

/** Parse a JSON object out of a model completion, tolerating prose/fences. */
function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The known tools the goal "names": a tool whose name (underscores read as
 * spaces) appears as a whole phrase in the goal. Conservative on purpose — the
 * fallback must not misfire.
 */
function namedTools(goal: string, tools: readonly ToolRef[]): ToolRef[] {
  const g = goal.toLowerCase().replace(/[_-]/g, " ");
  const out: ToolRef[] = [];
  for (const t of tools) {
    const phrase = escapeRegExp(t.tool.toLowerCase().replace(/[_-]/g, " ").trim());
    const re = new RegExp(`(^|\\s)${phrase}(\\s|$)`);
    if (re.test(g)) out.push(t);
  }
  return out;
}
