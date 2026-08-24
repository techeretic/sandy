import type { AuditEvent, AuditLogger } from "./logger.js";

/**
 * Session transcript (AU-03).
 *
 * The full ordered session audit trail, exportable as an artifact that
 * accompanies a generated report. This is the "show me exactly what happened"
 * record: every MCP call, file mutation, model invocation, and lifecycle
 * event, in sequence.
 */

export interface Transcript {
  /** ISO timestamp the transcript was captured. */
  capturedAt: string;
  /** Total events. */
  count: number;
  /** All events, in order. */
  events: readonly AuditEvent[];
}

/** Capture the current session transcript. */
export function captureTranscript(logger: AuditLogger): Transcript {
  const events = logger.events();
  return {
    capturedAt: new Date().toISOString(),
    count: events.length,
    events,
  };
}

/** Serialize a transcript to a JSON string (for attaching to a report). */
export function transcriptToJSON(transcript: Transcript): string {
  return JSON.stringify(transcript, null, 2);
}

/**
 * Render a transcript as a human-readable Markdown timeline. Useful as the
 * "how was this report produced" appendix.
 */
export function transcriptToMarkdown(transcript: Transcript): string {
  const lines: string[] = [
    `# Session transcript`,
    ``,
    `_Captured ${transcript.capturedAt} — ${transcript.count} event(s). Audit trail of every operation of consequence._`,
    ``,
  ];
  if (transcript.count === 0) {
    lines.push(`_(no events recorded)_`);
    return lines.join("\n");
  }
  lines.push(`| # | Time | Type | Detail |`);
  lines.push(`|---|------|------|--------|`);
  for (const event of transcript.events) {
    lines.push(`| ${event.seq} | ${event.at} | ${event.type} | ${describeEvent(event)} |`);
  }
  return lines.join("\n");
}

function describeEvent(event: AuditEvent): string {
  const d = event.data as Record<string, unknown>;
  const cell = (v: unknown) => (v === undefined ? "" : String(v).replace(/\|/g, "\\|").replace(/\n/g, " "));
  switch (event.type) {
    case "mcp_call":
      return `mcp \`${cell(d.server)}/${cell(d.tool)}\` → ${cell(d.outcome)}${cell(d.error) ? ` (${cell(d.error)})` : ""}`;
    case "file_mutation":
      return `${cell(d.op)} \`${cell(d.path)}\` → ${cell(d.outcome)}`;
    case "model_invocation":
      return `model \`${cell(d.provider)}${cell(d.model) ? `:${cell(d.model)}` : ""}\` in=${cell(d.inputTokens)} out=${cell(d.outputTokens)}`;
    case "orchestrator_task":
      return `task \`${cell(d.task)}\` → \`${cell(d.server)}/${cell(d.tool)}\` ${cell(d.outcome)}`;
    case "write_attempt":
      return d.allowed
        ? `write \`${cell(d.server)}/${cell(d.tool)}\` → allowed (approved by ${cell(d.approver)})`
        : `write \`${cell(d.server)}/${cell(d.tool)}\` → refused (${cell(d.reason)})`;
    case "sandbox_violation":
      return `violation: ${cell(d.detail)}`;
    case "egress_blocked":
      return `egress blocked: \`${cell(d.target)}\` (${cell(d.reason)})`;
    case "session_start":
      return `session started — goal: “${cell(d.goal)}”, ${cell(d.tasks)} task(s)`;
    case "session_end":
      return `session ended`;
    case "standalone_parse":
      return `parse (attempt ${cell(d.attempt)}/${cell(d.maxAttempts)}) → ${cell(d.outcome)}${cell(d.error) ? ` (${cell(d.error)})` : ""}`;
    case "standalone_plan":
      return `plan from ${cell(d.source)} after ${cell(d.attempts)} attempt(s)${cell(d.reason) ? ` — ${cell(d.reason)}` : ""}`;
    case "standalone_narrate":
      return `narrate → ${cell(d.outcome)}${cell(d.error) ? ` (${cell(d.error)})` : ""}`;
    default:
      return cell(JSON.stringify(d));
  }
}
