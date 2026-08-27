import { z } from "zod";
import type { LlmEngine } from "../engine.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import {
  callSignature,
  type Claim,
  type GatherTask,
  type Gap,
  type OrchestratorRequest,
  type ProgressEvent,
} from "../orchestrator/orchestrator.js";
import {
  gatherTaskSchema,
  toOrchestratorRequest,
  type OrchestratorRequestInput,
} from "../orchestrator/request.js";
import { validateRequest, type ToolRef } from "../orchestrator/templates.js";
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
 *  - **Multi-round is bounded and re-validated (issue #19).** With
 *    `maxPlanningRounds` > 1, after each gather pass the model re-plans from
 *    the previous rounds' claims/gaps: either `stop` (the data suffices) or
 *    ADDITIONAL gather tasks that pass the SAME `validatePlan()` gate as round
 *    1 — the legality can never loosen in a later round. A replan that only
 *    re-proposes calls already made is treated as stop (no re-gathering). On
 *    replan exhaustion the loop ends with what it has — never a crash, never
 *    an invented plan. All rounds aggregate into ONE report (one ask, one
 *    file): later rounds run without a report, and the final consolidated
 *    (claims, gaps) is re-rendered into the round-1 report path.
 *  - **Provenance is unaffected.** Claims come from MCP tool results, exactly as
 *    in plugin mode. The model only plans which tools to call and writes a
 *    clearly-labeled narrative.
 *  - **Every model call is audited** (`model_invocation`, via the engine) and
 *    each parse/narrate step is audited (`standalone_parse`/`standalone_narrate`).
 *  - **A dead model is reported, not a crash.** A failed invoke degrades to the
 *    fallback / no-narrative path; it never takes down the loop.
 */

export type { ToolRef } from "../orchestrator/templates.js";

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
  /**
   * Multi-turn / agentic planning (issue #19): after each gather pass the
   * model re-plans from the results so far — adding new gather tasks (re-
   * validated against the same schema + legal tool catalog) or stopping.
   * 1 (default) is the single gather→report pass; >1 enables the bounded
   * multi-round loop (never unbounded: the loop also ends early when there is
   * nothing new to gather).
   */
  maxPlanningRounds?: number;
}

export interface LoopResult {
  goal: string;
  claims: Claim[];
  gaps: Gap[];
  reportPath?: string;
  reportContent?: string;
  transcript: Transcript;
  /** How the round-1 plan was produced (model / deterministic fallback / refused). */
  plan: {
    source: "model" | "fallback" | "refused";
    attempts: number;
    reason?: string;
  };
  /**
   * Multi-round planning (issue #19): the outcome of the replan phase, present
   * when `maxPlanningRounds` > 1. `rounds` is the number of gather passes that
   * actually ran (1 = no replan happened); `gatheredRounds` is the subset of
   * them beyond round 1.
   */
  replanning?: {
    rounds: number;
    gatheredRounds: number;
    /** Why the replan phase ended: the model's stop, nothing new to gather,
     *  the model could not produce a legal follow-up (round 1's result stands),
     *  or the round cap. */
    stop: "stop" | "nothing-new" | "exhausted" | "max-rounds";
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

/** One replan decision (issue #19). */
type ReplanResult =
  | { kind: "stop"; reason: string }
  | { kind: "gather"; tasks: GatherTask[]; reason: string }
  | { kind: "failed"; reason: string };

/**
 * The replan decision (issue #19): the model looks at the rounds gathered so
 * far and either stops ("the data suffices") or proposes ADDITIONAL gather
 * tasks. `gather` is the same `gatherTaskSchema` as round 1 — the legality
 * gate (`validatePlan`) is applied to it by the loop, never trusted from the
 * model.
 */
export const replanDecisionSchema = z
  .object({
    decision: z.enum(["stop", "gather"]),
    reason: z.string().optional(),
    gather: z.array(gatherTaskSchema).min(1).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.decision === "gather" && (d.gather === undefined || d.gather.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gather"],
        message: '"gather" requires at least one new task',
      });
    }
  });

/**
 * JSON-schema constraint for the replan step (the structured-output knob, as
 * with `REQUEST_JSON_SCHEMA`). Best-effort: backends that can't honor it still
 * work — the loop validates the output itself regardless.
 */
const REPLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["stop", "gather"] },
    reason: { type: "string" },
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
  },
  required: ["decision"],
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
  private readonly maxRounds: number;

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
    this.maxRounds = Math.max(1, Math.floor(options.maxPlanningRounds ?? 1));
  }

  /** The current progress sink (Q4). */
  getProgressSink(): (event: ProgressEvent) => void {
    return this.onProgress;
  }

  /** Swap the progress sink (a service's job worker redirects per-job progress). */
  setProgressSink(sink: (event: ProgressEvent) => void): void {
    this.onProgress = sink;
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

    // One ask is ONE report: round 1 owns the report spec, later rounds gather
    // only and their results are merged into round 1's (claims, gaps), which is
    // then re-rendered into the same report path at the end.
    const request = toOrchestratorRequest(parsed.request);
    const first = await this.orchestrator.run(request);
    const claims: Claim[] = [...first.claims];
    const gaps: Gap[] = [...first.gaps];
    let reportPath = first.reportPath;
    let reportContent = first.reportContent;
    // Every call the loop has already made — the model may never re-propose one
    // (a "plan" that only re-gathers known calls is nothing new, not a round).
    const knownCalls = new Set(request.gather.map((t) => callSignature(t.server, t.tool, t.args)));
    const title = request.report?.title ?? goal;

    // Multi-round (issue #19): with `maxPlanningRounds` > 1 the model re-plans
    // from the results so far; every follow-up plan passes the SAME
    // validatePlan() gate as round 1 (the issue's invariant: the schema +
    // legal-tool-catalog check applies to every round, not just the first).
    let rounds = 1;
    let stop: "stop" | "nothing-new" | "exhausted" | "max-rounds" | undefined;
    if (this.maxRounds > 1) {
      while (rounds < this.maxRounds) {
        this.onProgress({ type: "replan-started", round: rounds + 1, maxRounds: this.maxRounds });
        const replan = await this.replan(goal, title, rounds, claims, gaps, knownCalls);
        if (replan.kind === "failed") {
          // The model could not produce a legal follow-up (or died): the
          // rounds gathered so far stand — reported, not a crash, and never an
          // invented plan.
          stop = "exhausted";
          this.audit.append("standalone_replan", {
            round: rounds,
            outcome: "failed",
            reason: replan.reason,
            stop: stop,
          });
          this.onProgress({ type: "replan-stopped", round: rounds, reason: "exhausted" });
          break;
        }
        if (replan.kind === "stop") {
          stop = "stop";
          this.audit.append("standalone_replan", { round: rounds, outcome: "stop", reason: replan.reason, stop: stop });
          this.onProgress({ type: "replan-stopped", round: rounds, reason: "stop" });
          break;
        }
        // replan.kind === "gather"
        // Nothing new to gather (everything proposed was already made): the
        // data the loop has is all there is — the model's re-proposal is not a
        // round, and re-running identical calls would be churn, not progress.
        if (replan.tasks.length === 0) {
          stop = "nothing-new";
          this.audit.append("standalone_replan", {
            round: rounds,
            outcome: "nothing-new",
            reason: replan.reason,
            stop: stop,
          });
          this.onProgress({ type: "replan-stopped", round: rounds, reason: "nothing-new" });
          break;
        }
        // No report this round: the consolidated report is written once, at
        // the end of the loop, into round 1's path.
        const next = toOrchestratorRequest({ goal, gather: replan.tasks });
        const res = await this.orchestrator.run(next);
        rounds += 1;
        for (const t of next.gather) knownCalls.add(callSignature(t.server, t.tool, t.args));
        claims.push(...res.claims);
        gaps.push(...res.gaps);
        if (res.reportPath) reportPath = res.reportPath;
        if (res.reportContent) reportContent = res.reportContent;
        this.audit.append("standalone_replan", {
          round: rounds,
          outcome: "gathered",
          tasks: next.gather.length,
          claims: res.claims.length,
          gaps: res.gaps.length,
        });
      }
      if (stop === undefined) {
        stop = "max-rounds";
        this.audit.append("standalone_replan", { round: rounds, outcome: "max-rounds", stop: stop });
        this.onProgress({ type: "replan-stopped", round: rounds, reason: "max-rounds" });
      }
      // No round beyond the first ran: the report round 1 wrote IS the
      // consolidated report — nothing to renumber or re-render.
      if (rounds > 1 && reportPath && reportContent !== undefined) {
        // Each `orchestrator.run` numbers its claims from 1, so the merged
        // claims across rounds have duplicate refs (and the consolidated report
        // would carry duplicate footnotes). Renumber the consolidated sequence
        // — provenance (source) is untouched; only the footnote numbers move.
        for (let i = 0; i < claims.length; i++) claims[i] = { ...claims[i]!, ref: i + 1 };
        // One report per ask: re-render the consolidated (claims, gaps) into
        // the report round 1 wrote. Best-effort — a failure to re-write here
        // does not discard the gathered data (the claims/gaps are returned
        // regardless).
        const consolidatedPath = reportPath;
        try {
          const content = renderReport(this.reportFormat, {
            goal,
            title,
            claims,
            gaps,
            generatedAt: new Date().toISOString(),
          });
          await this.files.write(consolidatedPath, content, { confirmed: true });
          reportContent = content;
          this.audit.append("standalone_replan", { round: rounds, outcome: "consolidated", report: consolidatedPath });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.audit.append("standalone_replan", { round: rounds, outcome: "consolidate-error", error });
        }
      }
    }

    const plan: LoopResult["plan"] =
      parsed.kind === "fallback"
        ? { source: "fallback", attempts: parsed.attempts, reason: parsed.reason }
        : { source: "model", attempts: parsed.attempts };

    const loopResult: LoopResult = {
      goal,
      claims,
      gaps,
      reportPath,
      reportContent,
      transcript: first.transcript,
      plan,
      request,
      ...(this.maxRounds > 1
        ? {
            replanning: {
              rounds,
              gatheredRounds: Math.max(0, rounds - 1),
              stop: stop ?? "max-rounds",
            },
          }
        : {}),
    };

    // Narrate (optional): a clearly-labeled model summary of the claims, re-
    // rendered into the report's Summary slot. Degrades gracefully on a dead
    // model — the deterministic report already written stands.
    if (this.narrateEnabled && reportPath && reportContent) {
      const narrated = await this.narrate(goal, title, claims, gaps, reportPath);
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

  /**
   * Validate a raw model plan against the schema AND the legal tool catalog —
   * the same shared check every entry point uses (templates, CLI, API; issue
   * #15), so a plan can never be legal that an ad-hoc request could not be.
   */
  private validatePlan(
    obj: unknown,
  ): { ok: true; data: OrchestratorRequestInput } | { ok: false; error: string } {
    const validated = validateRequest(obj, this.tools);
    if (!validated.ok) return { ok: false, error: `plan failed validation: ${validated.error}` };
    return { ok: true, data: validated.data };
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

  // --- replan (multi-round, issue #19) --------------------------------------

  /**
   * One replan decision (issue #19): show the model the goal, the rounds
   * gathered so far (claims + gaps, truncated), and the calls already made;
   * ask it for either `stop` or ADDITIONAL gather tasks.
   *
   * The same invariants as round 1 apply, per round:
   *  - **Re-validated.** Each proposed task is checked with the shared
   *    `gatherTaskSchema` + the same `validateRequest` legal-tool-catalog gate
   *    (`validatePlan`) — a follow-up round can never be legal that round 1
   *    could not have been.
   *  - **Bounded.** Up to `maxAttempts` tries with the error fed back; on
   *    exhaustion the loop ends with what it has (a dead model is reported,
   *    never a crash, and nothing is invented).
   *  - **No re-gathering.** Tasks whose call (server, tool, canonicalized args)
   *    was already made are dropped — a plan with nothing new is "stop", so a
   *    weak model that just repeats itself terminates the loop instead of
   *    churning identical calls.
   */
  private async replan(
    goal: string,
    title: string,
    round: number,
    claims: Claim[],
    gaps: Gap[],
    knownCalls: ReadonlySet<string>,
  ): Promise<ReplanResult> {
    const prompt = buildReplanPrompt(goal, title, this.tools, claims, gaps, knownCalls);
    let lastError = "";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this.audit.append("standalone_replan", {
        round,
        attempt,
        maxAttempts: this.maxAttempts,
        stage: "invoke",
      });
      try {
        const res = await this.engine.invoke({
          prompt: attempt === 1 ? prompt : `${prompt}\n\nYour previous attempt was rejected:\n${lastError}\n\nFix it and respond with ONLY the JSON object.`,
          responseFormat: "json",
          jsonSchema: REPLAN_JSON_SCHEMA,
          maxTokens: 1024,
        });
        const obj = extractJsonObject(res.completion);
        if (obj === null) {
          lastError = "the model did not return valid JSON";
          this.audit.append("standalone_replan", { round, attempt, stage: "attempt-failed", error: lastError });
          this.onProgress({ type: "replan-attempt-failed", round, attempt, error: lastError });
          continue;
        }
        const decision = this.validateReplan(obj);
        if (!decision.ok) {
          lastError = decision.error;
          this.audit.append("standalone_replan", { round, attempt, stage: "attempt-failed", error: lastError });
          this.onProgress({ type: "replan-attempt-failed", round, attempt, error: lastError });
          continue;
        }
        if (decision.data.decision === "stop") {
          const reason = (typeof decision.data.reason === "string" && decision.data.reason.trim()) || "the model judged the data sufficient";
          this.audit.append("standalone_replan", { round, attempt, stage: "accepted", decision: "stop", reason });
          return { kind: "stop", reason };
        }
        // Drop re-proposed calls (already made) and keep only legal new ones.
        const fresh: GatherTask[] = [];
        for (const t of decision.data.gather) {
          if (knownCalls.has(callSignature(t.server, t.tool, t.args))) continue;
          fresh.push({
            id: t.id,
            server: t.server,
            tool: t.tool,
            args: t.args,
            ...(t.description !== undefined ? { description: t.description } : {}),
          });
        }
        const reason =
          (typeof decision.data.reason === "string" && decision.data.reason.trim()) ||
          "the model proposed additional gathering";
        this.audit.append("standalone_replan", {
          round,
          attempt,
          stage: "accepted",
          decision: "gather",
          tasks: fresh.length,
          reason,
        });
        return { kind: "gather", tasks: fresh, reason };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.audit.append("standalone_replan", { round, attempt, stage: "attempt-failed", error: lastError });
        this.onProgress({ type: "replan-attempt-failed", round, attempt, error: lastError });
      }
    }
    const reason = `could not derive a follow-up plan after ${this.maxAttempts} attempt(s): ${lastError || "no reason recorded"}`;
    this.audit.append("standalone_replan", { round, attempt: this.maxAttempts, stage: "exhausted", error: reason });
    return { kind: "failed", reason };
  }

  /**
   * Validate a raw replan decision: shape via the replan schema, then the SAME
   * `validatePlan()` gate as round 1 (schema + legal tool catalog) — the issue
   * #19 invariant that validation applies to every round, not just the first.
   */
  private validateReplan(
    obj: unknown,
  ):
    | { ok: true; data: { decision: "stop"; reason?: unknown } }
    | { ok: true; data: { decision: "gather"; reason?: unknown; gather: OrchestratorRequestInput["gather"] } }
    | { ok: false; error: string } {
    const shape = replanDecisionSchema.safeParse(obj);
    if (!shape.success) {
      const issues = shape.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { ok: false, error: `replan failed shape validation: ${issues}` };
    }
    if (shape.data.decision === "stop") {
      return { ok: true, data: { decision: "stop", reason: shape.data.reason } };
    }
    // superRefine guarantees a non-empty gather for the "gather" decision
    // (otherwise the parse above would have failed).
    const checked = this.validatePlan({ goal: "replan", gather: shape.data.gather! });
    if (!checked.ok) return { ok: false, error: checked.error };
    return { ok: true, data: { decision: "gather", reason: shape.data.reason, gather: checked.data.gather } };
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

/** Truncate long text for a prompt (claims can be verbose; the model only needs the gist). */
function truncate(s: string, max = 500): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [truncated]`;
}

function buildReplanPrompt(
  goal: string,
  title: string,
  tools: readonly ToolRef[],
  claims: Claim[],
  gaps: Gap[],
  knownCalls: ReadonlySet<string>,
): string {
  const toolList = tools.map((t) => `${t.server}/${t.tool}`).join("\n");
  const claimsText =
    claims
      .map((c) => `- [${c.ref}] (${c.source.server}/${c.source.tool}) ${truncate(c.text)}`)
      .join("\n") || "(no claims yet)";
  const gapsText =
    gaps.map((g) => `- ${g.server}/${g.tool} (task ${g.task}): ${g.reason} — ${truncate(g.detail)}`).join("\n") ||
    "(none)";
  const callsText =
    [...knownCalls].map((c) => `- ${truncate(c, 200)}`).join("\n") || "(none yet)";
  return (
    `You are the planning step of an offline report assistant, deciding whether to gather MORE data.\n\n` +
    `GOAL:\n"""\n${goal}\n"""\n\n` +
    `REPORT SO FAR ("${title}"), gathered in previous rounds:\n` +
    `CLAIMS:\n${claimsText}\n\n` +
    `GAPS:\n${gapsText}\n\n` +
    `TOOL CALLS ALREADY MADE (do NOT propose these again):\n${callsText}\n\n` +
    `TOOLS YOU MAY CALL (the only legal "server" and "tool" values):\n${toolList}\n\n` +
    `Decide: do the claims above fully address the goal, or is there clearly-missing data you can still gather?\n` +
    `Respond with ONLY a JSON object (no prose, no markdown fences) of exactly one of these shapes:\n` +
    `{"decision":"stop","reason":"<why the data is sufficient or nothing more can be gathered>"}\n` +
    `{"decision":"gather","reason":"<what is missing>","gather":[{"id":"<short-stable-id>","server":"<server>","tool":"<tool>","args":{}}]}\n\n` +
    `Rules:\n` +
    `- "server" and "tool" MUST come from the TOOLS list; never invent them.\n` +
    `- Only propose calls you have NOT made yet (the list above); each must clearly add data the goal needs.\n` +
    `- If the claims already answer the goal, or nothing more can be gathered, use "stop" — do not pad the report.\n` +
    `- "args" must be a JSON object (use {} if the tool needs no arguments).\n`
  );
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
