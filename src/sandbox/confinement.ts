import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export type ViolationReason =
  | "null-byte"
  | "escape-path"
  | "symlink-escape"
  | "root-missing";

export class SandboxViolationError extends Error {
  readonly reason: ViolationReason;
  readonly attempted: string;

  constructor(reason: ViolationReason, attempted: string, detail: string) {
    super(`sandbox violation (${reason}): ${detail}`);
    this.name = "SandboxViolationError";
    this.reason = reason;
    this.attempted = attempted;
  }
}

export interface FsStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface PathConfinementOptions {
  /** Injectable for tests; defaults to fs.realpath. */
  realpath?: (p: string) => Promise<string>;
  /** Injectable for tests; defaults to fs.stat. */
  stat?: (p: string) => Promise<FsStat>;
}

function isUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Confines filesystem access to the declared roots (SB-06).
 *
 * Every path handed to the file manager must first pass through
 * `resolve()`. The check is real-path based, so symlink traversal out of a
 * root is refused even when the lexical path stays inside it.
 */
export class PathConfinement {
  private readonly roots: readonly string[];
  private readonly realpathFn: (p: string) => Promise<string>;
  private readonly statFn: (p: string) => Promise<FsStat>;

  constructor(roots: readonly string[], options: PathConfinementOptions = {}) {
    if (roots.length === 0) {
      throw new SandboxViolationError("root-missing", "", "no filesystem roots declared");
    }
    this.roots = roots.map((root) => {
      const resolved = path.resolve(root);
      if (resolved.includes("\0")) {
        throw new SandboxViolationError("null-byte", root, "root contains a null byte");
      }
      return resolved;
    });
    this.realpathFn = options.realpath ?? ((p) => realpath(p));
    this.statFn = options.stat ?? ((p) => stat(p));
  }

  /** The first declared root; relative paths resolve against it. */
  get primaryRoot(): string {
    return this.roots[0] as string;
  }

  /** All declared roots, resolved lexically. */
  get declaredRoots(): readonly string[] {
    return this.roots;
  }

  /**
   * Resolve a requested path to its real, confined absolute path.
   *
   * @param candidate absolute path, or relative to the primary root
   * @throws SandboxViolationError on any attempt to leave the declared roots
   */
  async resolve(candidate: string): Promise<string> {
    if (candidate.includes("\0")) {
      throw new SandboxViolationError("null-byte", candidate, "path contains a null byte");
    }

    // Reject '..' segments lexically instead of letting resolution normalize
    // them away — traversal is an intent we must refuse, not erase.
    if (candidate.split(/[\\/]/).includes("..")) {
      throw new SandboxViolationError(
        "escape-path",
        candidate,
        `path "${candidate}" uses '..' traversal; express it relative to a working root`,
      );
    }

    const lexical = path.resolve(this.primaryRoot, candidate);
    const containing = this.roots.find((root) => isUnder(lexical, root));
    if (!containing) {
      throw new SandboxViolationError(
        "escape-path",
        candidate,
        `path "${candidate}" resolves to "${lexical}", which is outside the declared roots`,
      );
    }

    // The containing root must exist. Without this, a missing root would
    // simply match lexically against the reconstructed tail and let access
    // through to a sibling of the (absent) root.
    try {
      await this.statFn(containing);
    } catch (err) {
      if (isEnoent(err)) {
        throw new SandboxViolationError("root-missing", candidate, `working root does not exist: ${containing}`);
      }
      throw err;
    }

    // Walk up to the deepest existing prefix, remembering the missing tail.
    // This keeps create-before-exist workflows working while still resolving
    // every symlink that exists today.
    let existing = lexical;
    const tail: string[] = [];
    for (;;) {
      try {
        await this.statFn(existing);
        break;
      } catch (err) {
        if (!isEnoent(err)) throw err;
        const parent = path.dirname(existing);
        if (parent === existing) {
          throw new SandboxViolationError("root-missing", candidate, `working root is missing: ${containing}`);
        }
        tail.unshift(path.basename(existing));
        existing = parent;
      }
    }

    const real = await this.realpathFn(existing);
    const fullyReal = tail.length > 0 ? path.join(real, ...tail) : real;
    const insideReal = this.roots.some((root) => isUnder(fullyReal, root));

    if (!insideReal) {
      throw new SandboxViolationError(
        isUnder(lexical, containing) ? "symlink-escape" : "escape-path",
        candidate,
        `path "${candidate}" resolves to "${fullyReal}", which is outside the declared roots`,
      );
    }

    return fullyReal;
  }

  /** Synchronous, lexical-only membership test (for logging, not enforcement). */
  isInsideLexically(candidate: string): boolean {
    const lexical = path.resolve(this.primaryRoot, candidate);
    return this.roots.some((root) => isUnder(lexical, root));
  }
}
