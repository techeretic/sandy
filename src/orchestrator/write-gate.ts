import type { AuditLogger } from "../audit/logger.js";
import type { WriteAllowlistEntry } from "../config/schema.js";

export type { WriteAllowlistEntry };

/**
 * Write-approval gate (Q6).
 *
 * v1 is read-and-report: the default gate below (`ReadOnlyGate`) refuses
 * every write. This module fixes the CONTRACT any write path must satisfy,
 * and provides the policy-backed gate a deployment opts into:
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
 * A deployment that wants write back supplies a gate that implements
 * {@link WriteApprovalGate}; nothing else in the orchestrator changes.
 */

export interface WriteTask {
  /** Stable id for provenance/audit. */
  id: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

export type WriteDecision =
  | {
      allowed: true;
      /** The explicit approval that authorized this write (audited). */
      approval: WriteApproval;
    }
  | { allowed: false; reason: "not-allowed-by-policy" | "no-approval" | "gate-refused" };

/**
 * The gate a write task must pass before it is routed to a server.
 */
export interface WriteApprovalGate {
  /**
   * Decide whether this write may proceed. Must be a pure policy+approval
   * check — no side effects, no network. Returns a decision; the caller
   * audits it.
   *
   * `approval` is the explicit, per-write human approval (contract point 3),
   * when one is presented. Gates without a policy allowlist
   * ({@link ReadOnlyGate}) refuse regardless.
   */
  decide(
    task: WriteTask,
    approval?: WriteApproval,
  ): Promise<WriteDecision> | WriteDecision;
}

/**
 * v1 gate: refuses all writes (PRD non-goal: read-and-report only).
 */
export class ReadOnlyGate implements WriteApprovalGate {
  decide(_task: WriteTask, _approval?: WriteApproval): WriteDecision {
    return { allowed: false, reason: "gate-refused" };
  }
}

/**
 * An explicit, per-write human approval (Q6 contract point 3).
 *
 * The approval is the *auditable event*: it names who approved and why, and
 * it is bound to exactly one write task. It is created OUT-OF-BAND by a
 * human (or an approved automation) — Sandy never creates one itself (the
 * FM-04 "never auto-confirm" precedent). Because the approval carries the
 * task's id and the gate consumes it, it is single-use: re-presenting the
 * same approval (or using it for a different task) is refused.
 */
export interface WriteApproval {
  /** The write task id this approval is bound to (single-use, non-reusable). */
  taskId: string;
  /** Who approved — a human principal, or an approved automation's identity. */
  approver: string;
  /** Why the write was approved; lands in the audit record. */
  reason: string;
}

export interface PolicyApprovalGateOptions {
  /**
   * The admin write allowlist: the (server, tool) pairs a write may target.
   * Separate from, and stricter than, the read allowlist (CP-02). When
   * empty, EVERY write is refused — the default fail-closed posture.
   */
  allowlist: readonly WriteAllowlistEntry[];
  /**
   * Consume a presented approval. Single-use: the presented approval is
   * always removed. Default: an approval is valid on its first presentation
   * (or after an ahead-of-time {@link PolicyApprovalGate.approve}) and can
   * never be presented twice.
   */
  approvals?: {
    consume(approval: WriteApproval): boolean;
  };
}

/**
 * The policy-backed gate: allows a write only when BOTH hold —
 *
 *  1. the (server, tool) target is on the admin write allowlist, and
 *  2. an explicit, matching, unconsumed per-write approval is presented.
 *
 * The check is pure and side-effect-free (contract point 1): no network, no
 * I/O. The only mutation is consuming the presented approval so it can never
 * be reused (contract point 4). Every decision is audited by the caller
 * (contract point 5) — see {@link logWriteAttempt}.
 */
export class PolicyApprovalGate implements WriteApprovalGate {
  private readonly allowed = new Set<string>();
  private readonly seenApprovals = new Set<string>();
  private readonly pending = new Map<string, WriteApproval>();
  private readonly consumeApproval: (approval: WriteApproval) => boolean;

  constructor(options: PolicyApprovalGateOptions) {
    for (const entry of options.allowlist) {
      this.allowed.add(key(entry.server, entry.tool));
    }
    this.consumeApproval = options.approvals?.consume ?? ((approval) => this.consume(approval));
  }

  /**
   * Register an approval ahead of time (the out-of-band human action). An
   * approval can only be registered once and consumed once: re-presenting
   * the same (taskId, approver) is refused, so a captured approval can never
   * be replayed onto a second write.
   */
  approve(approval: WriteApproval): boolean {
    const id = approvalId(approval);
    if (this.seenApprovals.has(id)) return false;
    this.seenApprovals.add(id);
    this.pending.set(id, approval);
    return true;
  }

  /**
   * Consume a presented approval (single-use, contract point 4). The
   * approval is valid only on its FIRST presentation: an approval presented
   * and consumed can never be presented again (a captured approval cannot be
   * replayed onto a second write), and it can only be presented for the task
   * it is bound to (checked in {@link decide}). An approval may also be
   * registered ahead of time via {@link approve} (the plugin's flow); a
   * duplicate registration is refused either way.
   */
  private consume(approval: WriteApproval): boolean {
    const id = approvalId(approval);
    if (this.pending.has(id)) {
      this.pending.delete(id);
      return true;
    }
    if (this.seenApprovals.has(id)) return false;
    this.seenApprovals.add(id);
    return true;
  }

  /** Approvals registered but not yet consumed. */
  pendingApprovals(): readonly WriteApproval[] {
    return [...this.pending.values()];
  }

  /** The (server, tool) pairs on the allowlist, in configuration order. */
  allowlist(): readonly WriteAllowlistEntry[] {
    return [...this.allowed].map((k) => {
      const [server, tool] = k.split("\u0000");
      return { server: server as string, tool: tool as string };
    });
  }

  /**
   * Decide on a write. When an approval is presented it is consumed
   * (single-use) and, if it was valid, becomes the audited approval record
   * on the decision.
   */
  decide(task: WriteTask, approval?: WriteApproval): WriteDecision {
    if (!this.allowed.has(key(task.server, task.tool))) {
      return { allowed: false, reason: "not-allowed-by-policy" };
    }
    if (!approval) {
      return { allowed: false, reason: "no-approval" };
    }
    if (approval.taskId !== task.id) {
      // An approval bound to a different task is a forgery or a replay
      // attempt — refuse it (and it is never registered, so it can do no
      // further harm).
      return { allowed: false, reason: "no-approval" };
    }
    if (!this.consumeApproval(approval)) {
      return { allowed: false, reason: "no-approval" };
    }
    return { allowed: true, approval };
  }
}

function key(server: string, tool: string): string {
  return `${server}\u0000${tool}`;
}

function approvalId(approval: WriteApproval): string {
  return `${approval.taskId}\u0000${approval.approver}`;
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
    ...(decision.allowed
      ? { approver: decision.approval.approver, approval_reason: decision.approval.reason }
      : {}),
  });
}
