import { Ajv } from "ajv";
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
 *     than, the read allowlist (CP-02: policy > preferences). When an entry
 *     carries per-arg constraints (issue #16 v2), the write's args must
 *     satisfy them.
 *  3. A human (or an approved automation) must explicitly approve each
 *     write at runtime. The approval is itself an auditable event.
 *  4. Approval is per-write and non-reusable: there is no standing blanket
 *     consent. Approvals expire (the default TTL, or an explicit
 *     `expiresAt`) and can be revoked before they are used (issue #16 v2).
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

/**
 * Why a write was refused. Each reason is a distinct, audited refusal — an
 * expired or revoked approval is NOT folded into `no-approval` (the audit
 * record must say which bound was hit, issue #16 v2).
 */
export type WriteDenialReason =
  | "not-allowed-by-policy"
  | "no-approval"
  | "approval-expired"
  | "approval-revoked"
  | "args-not-allowed"
  | "gate-refused";

export type WriteDecision =
  | {
      allowed: true;
      /** The explicit approval that authorized this write (audited). */
      approval: WriteApproval;
    }
  | { allowed: false; reason: WriteDenialReason };

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
 *
 * Expiry (issue #16 v2): an approval may carry `expiresAt` (ISO-8601).
 * Without it, the gate's default TTL (measured from when the approval is
 * registered or first presented) applies. An approval that has expired — or
 * has been revoked via {@link PolicyApprovalGate.revoke} — is a terminal
 * refusal, never a silent downgrade.
 *
 * Single consent per (taskId, approver): a (taskId, approver) pair is a
 * durable identity — once it has been registered or presented it can never
 * re-approve, even after its consent expired or was revoked (a re-presented
 * expired/revoked consent is refused, and a re-registration is refused).
 * Re-consent for the same write therefore uses a FRESH task id: the task id
 * is the unit of a consent window, so a new id opens a new window. This is
 * the deliberate anti-replay stance — an approval is a one-time grant bound
 * to a specific task, not a re-usable standing consent.
 */
export interface WriteApproval {
  /** The write task id this approval is bound to (single-use, non-reusable). */
  taskId: string;
  /** Who approved — a human principal, or an approved automation's identity. */
  approver: string;
  /** Why the write was approved; lands in the audit record. */
  reason: string;
  /**
   * Optional explicit expiry (ISO-8601). When absent, the gate's default
   * approval TTL applies from the moment the approval is registered or
   * first presented.
   */
  expiresAt?: string;
}

export interface PolicyApprovalGateOptions {
  /**
   * The admin write allowlist: the (server, tool) pairs a write may target,
   * each optionally constrained on its args. Separate from, and stricter
   * than, the read allowlist (CP-02). When empty, EVERY write is refused —
   * the default fail-closed posture.
   */
  allowlist: readonly WriteAllowlistEntry[];
  /**
   * Default approval time-to-live in seconds (issue #16 v2), measured from
   * when the approval is registered or first presented. Approvals are never
   * valid without a bound: an expired approval is a terminal, audited
   * refusal. Default: 1800 (30 minutes).
   */
  approvalTtlSeconds?: number;
  /** Clock seam for tests (default: `Date.now`). */
  now?: () => number;
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
 * The policy-backed gate: allows a write only when ALL hold —
 *
 *  1. the (server, tool) target is on the admin write allowlist, and
 *  2. the write's args satisfy the entry's per-arg constraints, if any
 *     (issue #16 v2), and
 *  3. an explicit, matching, unconsumed, unexpired, unrevoked per-write
 *     approval is presented.
 *
 * The check is pure and side-effect-free (contract point 1): no network, no
 * I/O. The only mutation is consuming the presented approval so it can never
 * be reused (contract point 4). Every decision is audited by the caller
 * (contract point 5) — see {@link logWriteAttempt}.
 */
export class PolicyApprovalGate implements WriteApprovalGate {
  private readonly allowed = new Map<string, { args?: Record<string, unknown> }>();
  private readonly seenApprovals = new Set<string>();
  private readonly revoked = new Set<string>();
  private readonly pending = new Map<string, { approval: WriteApproval; expiresAt: number }>();
  private readonly consumeApproval: (approval: WriteApproval) => boolean;
  private readonly approvalTtlMs: number;
  private readonly now: () => number;
  // strict:true makes a MALFORMED constraint (an unknown keyword, an invalid
  // value) throw at compile time — the only safe reading, fail closed. With
  // strict:false ajv silently drops unknown keywords, which would turn a
  // typo'd constraint into a no-op and let the write through (fail open).
  private readonly ajv = new Ajv({ strict: true, allErrors: true });

  constructor(options: PolicyApprovalGateOptions) {
    for (const entry of options.allowlist) {
      this.allowed.set(key(entry.server, entry.tool), { args: entry.args });
    }
    this.consumeApproval = options.approvals?.consume ?? ((approval) => this.consume(approval));
    this.approvalTtlMs = (options.approvalTtlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS) * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  /** The default approval TTL, in seconds (surfaced in `check()`). */
  approvalTtlSeconds(): number {
    return Math.round(this.approvalTtlMs / 1000);
  }

  /**
   * Register an approval ahead of time (the out-of-band human action). An
   * approval can only be registered once and consumed once: re-presenting the
   * same (taskId, approver) is refused, so a captured approval can never be
   * replayed onto a second write. Returns false when refused (duplicate or
   * already revoked).
   */
  approve(approval: WriteApproval): boolean {
    const id = approvalId(approval);
    if (this.revoked.has(id) || this.seenApprovals.has(id)) return false;
    this.seenApprovals.add(id);
    this.pending.set(id, { approval, expiresAt: expiryMs(approval, this.now() + this.approvalTtlMs) });
    return true;
  }

  /**
   * Revoke pending approvals before they are used (issue #16 v2 — the user
   * withdraws consent). With `approver` given, only that (taskId, approver)
   * pair is revoked; without it, every pending approval for the task is. A
   * revoked pair can never approve a write again — re-presenting or
   * re-registering it is refused, not resurrected. Returns how many pending
   * approvals were revoked (0 when there was nothing to revoke).
   */
  revoke(taskId: string, approver?: string): number {
    let count = 0;
    for (const [id, { approval }] of [...this.pending]) {
      if (approval.taskId !== taskId) continue;
      if (approver !== undefined && approval.approver !== approver) continue;
      this.pending.delete(id);
      this.revoked.add(id);
      count++;
    }
    return count;
  }

  /**
   * The expiry (epoch ms) of the first pending approval for a task, if any —
   * what {@link PolicyApprovalGate.approve} computed when it was registered
   * (the earlier of the approval's `expiresAt` and the default TTL window).
   */
  pendingExpiry(taskId: string, approver?: string): number | undefined {
    for (const [id, { approval, expiresAt }] of this.pending) {
      if (approval.taskId === taskId && (approver === undefined || approval.approver === approver)) {
        return expiresAt;
      }
    }
    return undefined;
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
    if (this.revoked.has(id) || this.seenApprovals.has(id)) return false;
    this.seenApprovals.add(id);
    return true;
  }

  /** Approvals registered but not yet consumed (expired ones are not purged
   *  here — expiry is enforced at decide time, so an expired approval that
   *  was presented still gets its own audited reason). */
  pendingApprovals(): readonly WriteApproval[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  /** The (server, tool) pairs on the allowlist, in configuration order. */
  allowlist(): readonly WriteAllowlistEntry[] {
    return [...this.allowed.entries()].map(([k, v]) => {
      const [server, tool] = k.split("\u0000");
      return {
        server: server as string,
        tool: tool as string,
        ...(v.args !== undefined ? { args: v.args } : {}),
      };
    });
  }

  /**
   * Decide on a write. The effective approval is the one presented inline,
   * else a PENDING approval for the task (registered ahead of time via
   * {@link approve} — the consent flow, issue #16 v2). The effective approval
   * is consumed (single-use) and, if valid, becomes the audited approval
   * record on the decision. Refusals name their reason precisely: an expired
   * or revoked approval is NOT folded into `no-approval` — the audit record
   * must say which bound was hit.
   */
  decide(task: WriteTask, approval?: WriteApproval): WriteDecision {
    const entry = this.allowed.get(key(task.server, task.tool));
    if (!entry) {
      return { allowed: false, reason: "not-allowed-by-policy" };
    }
    if (entry.args !== undefined) {
      const problem = this.argsProblem(entry.args, task.args);
      if (problem !== undefined) {
        return { allowed: false, reason: "args-not-allowed" };
      }
    }
    let effective: WriteApproval | undefined;
    if (approval) {
      // An approval bound to a different task is a forgery or a replay
      // attempt — refuse it (and it is never registered, so it can do no
      // further harm).
      if (approval.taskId !== task.id) {
        return { allowed: false, reason: "no-approval" };
      }
      effective = approval;
    } else {
      effective = this.resolvePendingApproval(task.id);
    }
    if (!effective) {
      return { allowed: false, reason: "no-approval" };
    }
    const id = approvalId(effective);
    if (this.revoked.has(id)) {
      return { allowed: false, reason: "approval-revoked" };
    }
    const pendingEntry = this.pending.get(id);
    const expiresAt = pendingEntry?.expiresAt ?? expiryMs(effective, this.now() + this.approvalTtlMs);
    if (this.now() >= expiresAt) {
      return { allowed: false, reason: "approval-expired" };
    }
    if (!this.consumeApproval(effective)) {
      return { allowed: false, reason: "no-approval" };
    }
    return { allowed: true, approval: effective };
  }

  /**
   * The first pending, non-revoked approval bound to a task (the consent
   * flow): one registered ahead of time via {@link approve} but not yet
   * presented inline to {@link decide}.
   */
  private resolvePendingApproval(taskId: string): WriteApproval | undefined {
    for (const [id, { approval }] of this.pending) {
      if (approval.taskId === taskId && !this.revoked.has(id)) return approval;
    }
    return undefined;
  }

  /**
   * Per-arg constraint check (issue #16 v2). The entry's `args` is a JSON
   * Schema fragment matched per top-level key with the same semantics the
   * MCP SDK uses for `structuredContent` (ajv, draft-07): every constraint
   * stated must hold, and args may contain further keys. A key that carries
   * a constraint must be PRESENT in the write's args — a constraint is a
   * promise about the value, not a permission to omit it. An invalid
   * constraint fragment is itself a fail-closed refusal, never a pass.
   */
  private argsProblem(constraint: Record<string, unknown>, args: Record<string, unknown>): string | undefined {
    try {
      const schema: Record<string, unknown> = {
        type: "object",
        properties: {},
        required: Object.keys(constraint),
      };
      for (const [name, sub] of Object.entries(constraint)) {
        (schema["properties"] as Record<string, unknown>)[name] = sub;
      }
      const validate = this.ajv.compile(schema);
      if (validate(args)) return undefined;
      const errors: Array<{ instancePath?: string; message?: string }> = validate.errors ?? [];
      return errors.map((e) => `${e.instancePath || "(args)"} ${e.message}`.trim()).join("; ");
    } catch {
      // An invalid constraint is a misconfiguration: refusing is the only
      // safe reading (fail closed).
      return "invalid per-arg constraint in the write allowlist";
    }
  }
}

const DEFAULT_APPROVAL_TTL_SECONDS = 1800;

function key(server: string, tool: string): string {
  return `${server}\u0000${tool}`;
}

function approvalId(approval: { taskId: string; approver: string }): string {
  return `${approval.taskId}\u0000${approval.approver}`;
}

function expiryMs(approval: WriteApproval, defaultExpiry: number): number {
  if (approval.expiresAt === undefined) return defaultExpiry;
  const parsed = Date.parse(approval.expiresAt);
  if (Number.isNaN(parsed)) {
    // An unparseable expiry must not extend the approval past its default
    // bound: fail closed to the default TTL.
    return defaultExpiry;
  }
  return Math.min(parsed, defaultExpiry);
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
