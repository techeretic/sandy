import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { PolicyConfig } from "../config/schema.js";
import {
  PathConfinement,
  SandboxViolationError,
} from "../sandbox/confinement.js";
import { isIgnored, compilePatterns } from "./ignore.js";
import { detectFormat, validateContent } from "./format.js";
import {
  InMemoryJournal,
  type MutationJournal,
  type MutationOp,
  type MutationRecord,
  type ReverseMutation,
} from "./journal.js";

export type FileOpErrorReason =
  | "confirmation-required"
  | "ignored"
  | "format-invalid"
  | "violation"
  | "io"
  | "not-found";

export class FileOpError extends Error {
  readonly reason: FileOpErrorReason;
  readonly attempted: string;

  constructor(reason: FileOpErrorReason, attempted: string, detail: string) {
    super(`file operation failed (${reason}): ${detail}`);
    this.name = "FileOpError";
    this.reason = reason;
    this.attempted = attempted;
  }
}

/** Thrown when a confirmation-gated operation is attempted without confirmation. */
export class ConfirmationRequiredError extends FileOpError {
  constructor(operation: string, detail: string) {
    super("confirmation-required", operation, detail);
    this.name = "ConfirmationRequiredError";
  }
}

export interface FileMutationResult {
  /** False in dry-run mode (FM-06). */
  applied: boolean;
  /** Confined absolute path. */
  path: string;
  /** The journaled record when the mutation was applied. */
  journaled?: MutationRecord;
}

export interface FileReadResult {
  path: string;
  content: string;
  format: string;
}

export interface FileOpOptions {
  /** User has confirmed this operation (FM-04). */
  confirmed?: boolean;
  /** Plan only; no filesystem changes (FM-06). */
  dryRun?: boolean;
}

/** Audit sink for filesystem mutations (AU-01). */
export interface FileAuditSink {
  record(entry: { op: string; path: string; at: string; outcome: "ok" | "error"; error?: string; dryRun?: boolean }): void;
}

export class NullFileAuditSink implements FileAuditSink {
  record(): void {}
}

export interface FileManagerOptions {
  confinement: PathConfinement;
  policy: PolicyConfig;
  journal?: MutationJournal;
  audit?: FileAuditSink;
}

/**
 * Confined file and directory operations (FM-01..FM-08).
 *
 * Every path enters through PathConfinement (FM-03/SB-06); every mutation
 * passes the policy confirmation gates (FM-04), the ignore rules (FM-07),
 * format validation (FM-08), and is journaled for undo (FM-05).
 */
export class FileManager {
  private readonly confinement: PathConfinement;
  private readonly policy: PolicyConfig;
  private readonly journal: MutationJournal;
  private readonly audit: FileAuditSink;
  private readonly ignorePatterns: ReturnType<typeof compilePatterns>;

  constructor(options: FileManagerOptions) {
    this.confinement = options.confinement;
    this.policy = options.policy;
    this.audit = options.audit ?? new NullFileAuditSink();
    this.ignorePatterns = compilePatterns(options.policy.ignore_patterns);
    const reverse: ReverseMutation = (record) => this.reverse(record);
    this.journal = options.journal ?? new InMemoryJournal(this.policy.undo_depth, reverse);
  }

  /** Undo the last journaled mutation (FM-05). Resolves undefined if none. */
  undo(): Promise<MutationRecord | undefined> {
    return this.journal.undo().then((r) => r?.undone);
  }

  // --- Reads -----------------------------------------------------------

  /** Read a text file (FM-01). */
  async read(candidate: string): Promise<FileReadResult> {
    const abs = await this.confinement.resolve(candidate);
    this.assertNotIgnored(abs, candidate);
    const content = await this.io(candidate, () => readFile(abs, "utf8"), {
      notFound: `cannot read: ${abs}`,
    });
    return { path: abs, content, format: detectFormat(path.basename(abs)) };
  }

  /**
   * List entries under a directory (FM-01). Ignored entries are skipped and
   * never traversed (FM-07).
   */
  async list(candidate: string, options: { recursive?: boolean } = {}): Promise<string[]> {
    const abs = await this.confinement.resolve(candidate);
    this.assertNotIgnored(abs, candidate);
    const recursive = options.recursive ?? false;
    // Match ignore patterns against the confinement root (the same root that
    // read/write/delete use via assertNotIgnored), not the queried directory —
    // otherwise a pattern like "secrets/*.key" never matches a direct
    // list("secrets") (GHSA-r885-qm59-2mxf). Returned paths stay relative to
    // the queried directory (listRoot) — no change to the return contract.
    const confinementRoot = this.containingRoot(abs) ?? abs;
    const results: string[] = [];
    await this.walk(confinementRoot, abs, abs, recursive, results);
    return results;
  }

  private async walk(
    confinementRoot: string,
    listRoot: string,
    dir: string,
    recursive: boolean,
    out: string[],
  ): Promise<void> {
    const entries = await this.io(dir, () => readdir(dir, { withFileTypes: true }), {
      notFound: `directory not found: ${dir}`,
    });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const ignoreRel = path.relative(confinementRoot, full);
      if (isIgnored(ignoreRel, this.ignorePatterns)) continue;
      const listRel = path.relative(listRoot, full);
      out.push(listRel);
      if (recursive && entry.isDirectory()) {
        await this.walk(confinementRoot, listRoot, full, true, out);
      }
    }
  }

  // --- File mutations ---------------------------------------------------

  /**
   * Create or overwrite a file (FM-01). Overwriting an existing file requires
   * confirmation when the policy says so (FM-04).
   */
  async write(candidate: string, content: string, options: FileOpOptions = {}): Promise<FileMutationResult> {
    const abs = await this.confinement.resolve(candidate);
    this.assertNotIgnored(abs, candidate);

    const format = detectFormat(path.basename(abs));
    const formatError = validateContent(format, content);
    if (formatError !== null) {
      throw new FileOpError("format-invalid", candidate, formatError);
    }

    let existed = false;
    let priorContent: string | null = null;
    try {
      await stat(abs);
      existed = true;
      priorContent = await readFile(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (existed) {
      this.requireConfirmation("overwrite", candidate, `overwrite existing file ${abs}`, options);
    } else if (this.policy.confirmation_required.includes("create")) {
      this.requireConfirmation("create", candidate, `create new file ${abs}`, options);
    }

    const dryRun = options.dryRun ?? this.policy.dry_run_default;
    if (!dryRun) {
      await this.io(candidate, async () => {
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
      }, { notFound: `cannot write: ${abs}` });
    }

    const journaled = dryRun
      ? undefined
      : this.journal.record({
          op: existed ? "write-file" : "create-file",
          path: abs,
          before: priorContent,
          after: content,
        });

    this.audit.record({ op: dryRun ? "write(dry-run)" : "write", path: abs, at: new Date().toISOString(), outcome: "ok", dryRun });
    return { applied: !dryRun, path: abs, journaled };
  }

  /** Delete a file (FM-01/04). Confirmation-gated by policy. */
  async deleteFile(candidate: string, options: FileOpOptions = {}): Promise<FileMutationResult> {
    const abs = await this.confinement.resolve(candidate);
    this.assertNotIgnored(abs, candidate);

    let priorContent: string | null = null;
    try {
      const s = await stat(abs);
      if (s.isDirectory()) {
        throw new FileOpError("io", candidate, `${abs} is a directory; use deleteDirectory`);
      }
      priorContent = await readFile(abs, "utf8");
    } catch (err) {
      if (err instanceof FileOpError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileOpError("not-found", candidate, `no such file: ${abs}`);
      }
      throw err;
    }

    this.requireConfirmation("delete", candidate, `delete file ${abs}`, options);

    const dryRun = options.dryRun ?? this.policy.dry_run_default;
    if (!dryRun) {
      await this.io(candidate, () => rm(abs), { notFound: `cannot delete: ${abs}` });
    }

    const journaled = dryRun
      ? undefined
      : this.journal.record({ op: "delete-file", path: abs, before: priorContent, after: null });
    this.audit.record({ op: dryRun ? "delete(dry-run)" : "delete", path: abs, at: new Date().toISOString(), outcome: "ok", dryRun });
    return { applied: !dryRun, path: abs, journaled };
  }

  // --- Directory mutations ----------------------------------------------

  /** Create a directory (FM-02). */
  async createDirectory(candidate: string, options: FileOpOptions = {}): Promise<FileMutationResult> {
    const abs = await this.confinement.resolve(candidate);
    this.assertNotIgnored(abs, candidate);

    let existed = false;
    try {
      await stat(abs);
      existed = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (existed) {
      throw new FileOpError("io", candidate, `already exists: ${abs}`);
    }

    if (this.policy.confirmation_required.includes("create")) {
      this.requireConfirmation("create", candidate, `create directory ${abs}`, options);
    }

    const parent = path.dirname(abs);
    let parentExists = false;
    try {
      await stat(parent);
      parentExists = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!parentExists) {
      // We do not create directories implicitly beyond what was asked
      // (least privilege) — the caller must create each level explicitly.
      throw new FileOpError("not-found", candidate, `parent directory does not exist; create it first: ${parent}`);
    }

    const dryRun = options.dryRun ?? this.policy.dry_run_default;
    if (!dryRun) {
      await this.io(candidate, () => mkdir(abs, { recursive: false }), { notFound: `cannot create directory: ${abs}` });
    }

    const journaled = dryRun
      ? undefined
      : this.journal.record({ op: "create-directory", path: abs, before: null, after: true });
    this.audit.record({ op: dryRun ? "mkdir(dry-run)" : "mkdir", path: abs, at: new Date().toISOString(), outcome: "ok", dryRun });
    return { applied: !dryRun, path: abs, journaled };
  }

  /** Rename or move a file or directory (FM-02). Both sides must be confined. */
  async rename(from: string, to: string, options: FileOpOptions = {}): Promise<FileMutationResult> {
    const absFrom = await this.confinement.resolve(from);
    const absTo = await this.confinement.resolve(to);
    this.assertNotIgnored(absFrom, from);
    this.assertNotIgnored(absTo, to);

    await stat(absFrom).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileOpError("not-found", from, `no such file or directory: ${absFrom}`);
      }
      throw err;
    });

    this.requireConfirmation("rename", from, `rename ${absFrom} -> ${absTo}`, options);

    const dryRun = options.dryRun ?? this.policy.dry_run_default;
    if (!dryRun) {
      await this.io(from, () => rename(absFrom, absTo), { notFound: `cannot rename: ${absFrom}` });
    }

    const journaled = dryRun
      ? undefined
      : this.journal.record({ op: "rename", path: absFrom, to: absTo, before: true, after: true });
    this.audit.record({ op: dryRun ? "rename(dry-run)" : "rename", path: `${absFrom} -> ${absTo}`, at: new Date().toISOString(), outcome: "ok", dryRun });
    return { applied: !dryRun, path: absFrom, journaled };
  }

  /**
   * Delete a directory and its contents (FM-02/04). Confirmation-gated by
   * policy; the subtree is snapshotted so undo can restore it (FM-05).
   */
  async deleteDirectory(candidate: string, options: FileOpOptions = {}): Promise<FileMutationResult> {
    const abs = await this.confinement.resolve(candidate);
    this.assertNotIgnored(abs, candidate);

    let isDir = false;
    try {
      const s = await stat(abs);
      isDir = s.isDirectory();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileOpError("not-found", candidate, `no such directory: ${abs}`);
      }
      throw err;
    }
    if (!isDir) {
      throw new FileOpError("io", candidate, `${abs} is not a directory; use deleteFile`);
    }

    this.requireConfirmation("delete", candidate, `delete directory ${abs} and all of its contents`, options);

    const snapshot = dryRunOf(options)
      ? null
      : await snapshotDirectory(abs);

    const dryRun = options.dryRun ?? this.policy.dry_run_default;
    if (!dryRun) {
      await this.io(candidate, () => rm(abs, { recursive: true }), { notFound: `cannot delete: ${abs}` });
    }

    const journaled = dryRun
      ? undefined
      : this.journal.record({ op: "delete-directory", path: abs, before: snapshot, after: null });
    this.audit.record({ op: dryRun ? "rmdir(dry-run)" : "rmdir", path: abs, at: new Date().toISOString(), outcome: "ok", dryRun });
    return { applied: !dryRun, path: abs, journaled };
  }

  // --- Internals ---------------------------------------------------------

  private requireConfirmation(
    kind: "delete" | "overwrite" | "rename" | "create",
    attempted: string,
    detail: string,
    options: FileOpOptions,
  ): void {
    if (!this.policy.confirmation_required.includes(kind)) return;
    if (options.confirmed) return;
    if (options.dryRun) return;
    throw new ConfirmationRequiredError(attempted, `${detail} requires confirmation (policy: ${kind})`);
  }

  private assertNotIgnored(abs: string, candidate: string): void {
    const root = this.containingRoot(abs);
    const rel = root ? path.relative(root, abs) : path.basename(abs);
    if (isIgnored(rel, this.ignorePatterns)) {
      throw new FileOpError("ignored", candidate, `path is excluded by ignore patterns: ${rel}`);
    }
  }

  private containingRoot(abs: string): string | undefined {
    return this.confinement.declaredRoots.find(
      (root) => abs === root || abs.startsWith(root + path.sep),
    );
  }

  private async io<T>(
    candidate: string,
    fn: () => Promise<T>,
    flags: { notFound: string },
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SandboxViolationError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new FileOpError("not-found", candidate, flags.notFound);
      const wrapped = new FileOpError("io", candidate, err instanceof Error ? err.message : String(err));
      this.audit.record({ op: "io-error", path: candidate, at: new Date().toISOString(), outcome: "error", error: wrapped.message });
      throw wrapped;
    }
  }

  private async reverse(record: MutationRecord): Promise<void> {
    // Re-resolve every path through PathConfinement before touching it, so undo
    // gets the same real-path/symlink-escape check every live mutation gets.
    // A path swapped for a symlink between the original mutation and a later
    // undo() in the same session is refused (SandboxViolationError), not
    // followed (GHSA-w84c-rwhv-mrgx).
    const target = await this.confinement.resolve(record.path);
    switch (record.op) {
      case "create-file":
        await this.rmSafe(target);
        break;
      case "write-file":
        if (record.before === null) await this.rmSafe(target);
        else await writeFile(target, record.before as string, "utf8");
        break;
      case "delete-file":
        if (record.before !== null) {
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, record.before as string, "utf8");
        }
        break;
      case "create-directory":
        await rm(target, { recursive: true });
        break;
      case "delete-directory": {
        const snapshot = record.before as SubtreeSnapshot | null;
        if (snapshot) {
          await restoreDirectory(target, snapshot);
        }
        break;
      }
      case "rename":
        if (record.to) {
          const to = await this.confinement.resolve(record.to);
          await rename(to, target);
        }
        break;
    }
  }

  private async rmSafe(p: string): Promise<void> {
    await rm(p, { force: true });
  }
}

function dryRunOf(options: FileOpOptions): boolean {
  return options.dryRun ?? false;
}

export interface SubtreeSnapshot {
  files: Array<{ rel: string; content: string }>;
  dirs: string[];
}

async function snapshotDirectory(root: string): Promise<SubtreeSnapshot> {
  const snapshot: SubtreeSnapshot = { files: [], dirs: [] };
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        snapshot.dirs.push(rel);
        await walk(full);
      } else if (entry.isFile()) {
        snapshot.files.push({ rel, content: await readFile(full, "utf8") });
      }
    }
  }
  await walk(root);
  return snapshot;
}

async function restoreDirectory(root: string, snapshot: SubtreeSnapshot): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const dir of [...snapshot.dirs].reverse()) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  for (const file of snapshot.files) {
    const full = path.join(root, file.rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, file.content, "utf8");
  }
}

export type { MutationOp };
