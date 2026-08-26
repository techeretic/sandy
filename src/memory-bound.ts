import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * In-service hard memory bound for the bundled model's process group
 * (issue #18, design §4.5 — the "small, flagged addition" the design pointed
 * at). The default posture is unchanged: the *hard* ceiling is the service
 * manager's cgroup (`memory.max` / `--memory` / `MemoryMax=`). When the
 * operator opts in (`sandbox.enforce_memory_limit: true`), the model's process
 * is wrapped in a dedicated cgroup v2 child with `memory.max` set to the
 * declared `sandbox.max_memory_mb`, so the ceiling holds even when the
 * supervisor does not enforce one.
 *
 * cgroup v2 delegation is the prerequisite: a cgroup can only get the memory
 * controller enabled on its children (`+memory` in the parent's
 * `cgroup.subtree_control`) if no member process sits in the parent. On a
 * systemd host that is what `Delegate=yes` (a scope/unit) sets up; a plain
 * container whose cgroup namespace root holds processes cannot do it (the
 * kernel rejects it — "no internal processes"). Everything that cannot be
 * verified is a {@link MemoryBoundError}, never a silent no-op: the engine
 * fails closed (degraded) rather than run a model the operator asked to cap
 * without the cap (the repo's "never silently unbounded" law).
 *
 * All fs access goes through injectable {@link MemoryBoundOps} so the whole
 * sequence is testable with no root, no cgroupfs, and no privileged sandbox.
 */

export interface MemoryBoundOps {
  readFileSync(p: string): string;
  writeFileSync(p: string, data: string): void;
  existsSync(p: string): boolean;
  mkdirSync(p: string): void;
  rmdirSync(p: string): void;
}

export const defaultMemoryBoundOps: MemoryBoundOps = {
  readFileSync: (p) => readFileSync(p, "utf8"),
  writeFileSync: (p, data) => writeFileSync(p, data),
  existsSync,
  mkdirSync,
  rmdirSync,
};

/** Thrown (and by the engine, surfaced as a degraded engine) when the bound
 *  cannot be created/attached. The message names the cause so the operator
 *  can fix the delegation, not just discover a degraded engine. */
export class MemoryBoundError extends Error {}

export interface MemoryBoundResult {
  /** The cgroup directory the process was moved into. */
  cgroupPath: string;
  /** The enforced ceiling, in bytes. */
  limitBytes: number;
}

const CGROUP2_ROOT = "/sys/fs/cgroup";

/** The unified-hierarchy (cgroup v2) path of the calling process, from
 *  /proc/self/cgroup (a line of the form `0::/path`). */
function selfCgroupPath(ops: MemoryBoundOps): string {
  const raw = ops.readFileSync("/proc/self/cgroup");
  for (const line of raw.split("\n")) {
    const m = /^0::(.+)$/.exec(line.trim());
    if (m?.[1]) return m[1];
  }
  throw new MemoryBoundError(
    "no cgroup v2 (unified) hierarchy in /proc/self/cgroup; an in-service memory bound requires cgroup v2",
  );
}

/** True when `dir`'s subtree_control has the memory controller enabled, i.e.
 *  children under it may carry a `memory.max` bound. */
function memoryDelegatedToChildren(dir: string, ops: MemoryBoundOps): boolean {
  const sc = path.posix.join(dir, "cgroup.subtree_control");
  if (!ops.existsSync(sc)) return false;
  let content: string;
  try {
    content = ops.readFileSync(sc);
  } catch {
    return false;
  }
  return content
    .split(/\s+/)
    .filter(Boolean)
    .some((tok) => tok === "memory" || tok === "+memory");
}

/**
 * Find the nearest ancestor (starting at the calling process's parent) that
 * has the memory controller delegated to its children. Returns null when none
 * does — the fail-closed case (e.g. a plain container without delegation).
 */
function findDelegatedMemoryParent(selfPath: string, ops: MemoryBoundOps): string | null {
  let dir = path.posix.dirname(path.posix.join(CGROUP2_ROOT, selfPath));
  for (;;) {
    if (memoryDelegatedToChildren(dir, ops)) return dir;
    if (dir === CGROUP2_ROOT) return null;
    dir = path.posix.dirname(dir);
  }
}

/**
 * Move `pid` into a fresh cgroup v2 child of the nearest delegated ancestor
 * with `memory.max` set to `limitBytes`. Fail-closed: any step that cannot be
 * verified throws a {@link MemoryBoundError}, and a partially-created cgroup
 * is removed before the throw. The process's descendants inherit the cgroup,
 * so the whole model process group is bounded.
 */
export function wrapProcessInMemoryCgroup(
  pid: number,
  limitBytes: number,
  ops: MemoryBoundOps = defaultMemoryBoundOps,
): MemoryBoundResult {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new MemoryBoundError(`invalid pid ${pid} for the memory bound`);
  }
  if (!Number.isInteger(limitBytes) || limitBytes <= 0) {
    throw new MemoryBoundError(`invalid memory limit ${limitBytes} bytes`);
  }
  const selfPath = selfCgroupPath(ops);
  if (selfPath === "/") {
    throw new MemoryBoundError(
      "the process runs in a cgroup namespace root without a delegating parent; an in-service memory bound requires delegation (e.g. a systemd scope or service unit with Delegate=yes) — the kernel will not enable the memory controller on a cgroup that holds processes",
    );
  }
  const parent = findDelegatedMemoryParent(selfPath, ops);
  if (parent === null) {
    throw new MemoryBoundError(
      "no cgroup v2 ancestor has the memory controller delegated to its children (cgroup.subtree_control); an in-service memory bound requires delegation (e.g. a systemd scope or service unit with Delegate=yes)",
    );
  }
  const childPath = path.posix.join(parent, `sandy-model-${pid}`);
  let created = false;
  try {
    if (ops.existsSync(childPath)) {
      // A stale EMPTY dir from an earlier crashed run is safe to reclaim; a
      // non-empty one throws (rmdir) and fails closed below.
      ops.rmdirSync(childPath);
    }
    ops.mkdirSync(childPath);
    created = true;
    ops.writeFileSync(path.posix.join(childPath, "memory.max"), String(limitBytes));
    ops.writeFileSync(path.posix.join(childPath, "cgroup.procs"), String(pid));
  } catch (err) {
    if (created) {
      try {
        ops.rmdirSync(childPath);
      } catch {
        /* best effort: the error below is the surfaced signal */
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new MemoryBoundError(`could not attach the model to a memory-bounded cgroup (${childPath}): ${msg}`);
  }
  return { cgroupPath: childPath, limitBytes };
}

/**
 * Best-effort removal of a bound's cgroup after the model has exited. Returns
 * true when the directory was removed; false when it still exists (e.g. the
 * process has not fully reaped yet) — the caller surfaces that, it is never
 * smoothed over.
 */
export function releaseMemoryCgroup(
  cgroupPath: string,
  ops: MemoryBoundOps = defaultMemoryBoundOps,
): boolean {
  try {
    ops.rmdirSync(cgroupPath);
    return true;
  } catch {
    return false;
  }
}
