/**
 * Mutation journal (FM-05, design-now).
 *
 * Every filesystem mutation is journaled with before/after state so the last
 * N operations can be undone within a session. This is the seam where the
 * write-approval gate (PRD Q6) will hook in later: an operation only reaches
 * the journal after it has passed confirmation.
 *
 * The journal is in-memory and session-scoped (v1 is session-scoped per Q8).
 * `InMemoryJournal` is the reference implementation; a durable backend can be
 * added behind the same interface without touching the File Manager.
 */

export type MutationOp =
  | "write-file"
  | "create-file"
  | "delete-file"
  | "write-directory"
  | "create-directory"
  | "delete-directory"
  | "rename";

export interface MutationRecord {
  op: MutationOp;
  /** Absolute, confined path (post-confinement). */
  path: string;
  /** For rename: the destination. */
  to?: string;
  /**
   * Snapshot needed to reverse the operation.
   *  - file: prior content (null if the file did not exist)
   *  - directory: whether it existed and, for delete, a full subtree snapshot
   */
  before: unknown;
  /** What the operation produced. */
  after: unknown;
  at: string;
}

export interface UndoResult {
  undone: MutationRecord;
}

/**
 * A journal that records mutations and can undo the last N.
 */
export interface MutationJournal {
  record(entry: Omit<MutationRecord, "at">): MutationRecord;
  /** Number of operations currently undoable. */
  size(): number;
  /**
   * Reverse the most recent operation. Returns false if the journal is empty.
   * `apply` must perform the actual filesystem reversal; the journal only
   * tracks order and state.
   */
  pop(): MutationRecord | undefined;
  /**
   * Reverse the most recent operation, performing the real filesystem
   * reversal. Returns the undone record, or undefined if there is none.
   */
  undo(): Promise<UndoResult | undefined>;
  /** Max undo depth. 0 means undo is disabled. */
  readonly depth: number;
}

/** Reverse a single journaled mutation on disk. Injected so the journal stays I/O-free. */
export type ReverseMutation = (record: MutationRecord) => Promise<void>;

/**
 * In-memory, session-scoped journal (FM-05).
 */
export class InMemoryJournal implements MutationJournal {
  private stack: MutationRecord[] = [];

  constructor(
    private readonly maxDepth: number,
    private readonly reverse: ReverseMutation,
  ) {}

  get depth(): number {
    return this.maxDepth;
  }

  record(entry: Omit<MutationRecord, "at">): MutationRecord {
    const record: MutationRecord = { ...entry, at: new Date().toISOString() };
    this.stack.push(record);
    // Enforce undo depth (FM-05: undo of the last N operations).
    while (this.stack.length > this.maxDepth) {
      this.stack.shift();
    }
    return record;
  }

  size(): number {
    return this.stack.length;
  }

  pop(): MutationRecord | undefined {
    return this.stack.pop();
  }

  /**
   * Undo the most recent operation, performing the real filesystem reversal.
   * Returns the undone record, or undefined if there is nothing to undo.
   */
  async undo(): Promise<UndoResult | undefined> {
    const record = this.stack.pop();
    if (!record) return undefined;
    await this.reverse(record);
    return { undone: record };
  }
}
