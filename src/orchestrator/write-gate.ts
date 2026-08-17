import type { AuditLogger } from "../audit/logger.js";

/**
 * Write-approval gate (Q6 — designed now, implemented later).
 *
 * v1 is read-and-report: Sandy never writes to internal systems. This module
 * fixes the CONTRACT a future write-back path must satisfy, so it can be
 * added without rework:
 *
 *  1. A write is a first-class task kind, distinct from a gather task.
 *  2. Every write target (server, tool, args) must be matched against the
 *     admin policy's write allowlist — which is separate from, and stricter
 *     than, the read allowlist (CP-02: policy > preferences).
 *  3. A human (or an approved automation) must explicitly approve each
 *     write at runtime. The approval is itself an auditable event.
 *  4. Approval is per-write and non-reusable: there is no standing blanket
 *     consent.
 *  5. A denied or unapproved write is a terminal, audited rejection — it is
 *     never retried silently.
 *
 * The default gate below refuses EVERYTHING. A deployment that wants write
 * back supplies a gate that implements the same interface; nothing else in
 * the orchestrator changes.
 */

export interface WriteTask {
  /** Stable id for provenance/audit. */
  id: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

export type WriteDecision =
  | { allowed: true }
  | { allowed: false; reason: "not-allowed-by-policy" | "no-approval" | "gate-refused" };

/**
 * The gate a write task must pass before it is routed to a server.
 */
export interface WriteApprovalGate {
  /**
   * Decide whether this write may proceed. Must be a pure policy+approval
   * check — no side effects, no network. Returns a decision; the caller
   * audits it.
   */
  decide(task: WriteTask): Promise<WriteDecision> | WriteDecision;
}

/**
 * v1 gate: refuses all writes (PRD non-goal: read-and-report only).
 */
export class ReadOnlyGate implements WriteApprovalGate {
  decide(_task: WriteTask): WriteDecision {
    return { allowed: false, reason: "gate-refused" };
  }
}

/**
 * Record a write attempt + decision to the audit log (AU-01). Called for
 * every write regardless of outcome — the audit trail must show what was
 * attempted and why it was allowed or refused.
 */
export function logWriteAttempt(
  logger: AuditLogger,
  task: WriteTask,
  decision: WriteDecision,
): void {
  logger.append("write_attempt", {
    task: task.id,
    server: task.server,
    tool: task.tool,
    allowed: decision.allowed,
    reason: decision.allowed ? null : decision.reason,
  });
}
