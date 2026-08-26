import { describe, expect, it } from "vitest";
import {
  MemoryBoundError,
  releaseMemoryCgroup,
  wrapProcessInMemoryCgroup,
  type MemoryBoundOps,
} from "../src/index.js";

/**
 * An in-memory model of the cgroup v2 filesystem, enough to exercise the whole
 * wrap/release sequence with no root, no cgroupfs, and no privileged sandbox.
 * Files live in `files`, cgroup directories in `dirs`. /proc/self/cgroup is a
 * fixed string. The semantics mirror the kernel closely enough to pin the
 * discovery + fail-closed behavior this issue is about.
 */
function fakeOps(
  opts: {
    selfCgroup: string;
    /** cgroup dir paths -> cgroup.subtree_control content (delegated controllers). */
    subtreeControl?: Record<string, string>;
    /** cgroup dirs that already exist (e.g. a stale empty one to reclaim). */
    preExistingDirs?: string[];
  },
): { ops: MemoryBoundOps; files: Record<string, string>; dirs: Set<string> } {
  const files: Record<string, string> = {};
  for (const [dir, content] of Object.entries(opts.subtreeControl ?? {})) {
    files[`${dir}/cgroup.subtree_control`] = content;
  }
  const dirs = new Set<string>(opts.preExistingDirs ?? []);
  const ops: MemoryBoundOps = {
    readFileSync: (p: string) => {
      if (p === "/proc/self/cgroup") return opts.selfCgroup;
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT: no such file or directory: ${p}`);
      return v;
    },
    writeFileSync: (p: string, data: string) => {
      files[p] = data;
    },
    existsSync: (p: string) => files[p] !== undefined || dirs.has(p),
    mkdirSync: (p: string) => {
      if (dirs.has(p)) throw new Error(`EEXIST: file exists: ${p}`);
      dirs.add(p);
    },
    rmdirSync: (p: string) => {
      if (!dirs.has(p)) throw new Error(`ENOENT: cannot rmdir: ${p}`);
      dirs.delete(p);
    },
  };
  return { ops, files, dirs };
}

const SELF = "0::/user.slice/user-1000.slice/session.scope\n";
const PARENT = "/sys/fs/cgroup/user.slice/user-1000.slice";
const CHILD = (pid: number) => `${PARENT}/sandy-model-${pid}`;

describe("wrapProcessInMemoryCgroup (issue #18, design §4.5)", () => {
  it("moves the pid into a memory-bounded child of the nearest delegated ancestor", () => {
    const { ops, files, dirs } = fakeOps({
      selfCgroup: SELF,
      subtreeControl: { [PARENT]: "cpu memory pids" },
    });
    const res = wrapProcessInMemoryCgroup(4242, 536870912, ops);
    expect(res.cgroupPath).toBe(CHILD(4242));
    expect(res.limitBytes).toBe(536870912);
    // The child cgroup was created under the delegated parent...
    expect(dirs.has(CHILD(4242))).toBe(true);
    // ...with the ceiling set to the requested limit (bytes)...
    expect(files[`${CHILD(4242)}/memory.max`]).toBe("536870912");
    // ...and the process moved in (the whole process group is then bounded).
    expect(files[`${CHILD(4242)}/cgroup.procs`]).toBe("4242");
  });

  it("walks up to the nearest ancestor that has memory delegated (skips non-delegated ones)", () => {
    // The immediate parent has NO memory delegation; the grandparent does.
    const { ops, dirs } = fakeOps({
      selfCgroup: "0::/a.slice/b.slice/scope.scope\n",
      subtreeControl: {
        "/sys/fs/cgroup/a.slice": "", // cpu only, no memory
        "/sys/fs/cgroup/a.slice/b.slice": "cpu memory pids",
      },
    });
    const res = wrapProcessInMemoryCgroup(7, 1024, ops);
    // The bound lands under the delegated grandparent, not the non-delegated parent.
    expect(res.cgroupPath).toBe("/sys/fs/cgroup/a.slice/b.slice/sandy-model-7");
    expect(dirs.has("/sys/fs/cgroup/a.slice/b.slice/sandy-model-7")).toBe(true);
  });

  it("fails closed when the process sits in a cgroup namespace root (no delegating parent)", () => {
    const { ops } = fakeOps({ selfCgroup: "0::/\n" });
    expect(() => wrapProcessInMemoryCgroup(1, 1024, ops)).toThrow(MemoryBoundError);
    expect(() => wrapProcessInMemoryCgroup(1, 1024, ops)).toThrow(/delegation/i);
  });

  it("fails closed when no ancestor has the memory controller delegated", () => {
    const { ops, dirs } = fakeOps({
      selfCgroup: SELF,
      subtreeControl: { [PARENT]: "cpu pids" }, // no memory
    });
    expect(() => wrapProcessInMemoryCgroup(9, 1024, ops)).toThrow(MemoryBoundError);
    expect(() => wrapProcessInMemoryCgroup(9, 1024, ops)).toThrow(/delegation/i);
    // Nothing was created.
    expect(dirs.size).toBe(0);
  });

  it("fails closed when there is no cgroup v2 hierarchy at all", () => {
    // Only legacy (v1) lines -> no unified (0::) path.
    const { ops } = fakeOps({ selfCgroup: "12:memory:/\n1:name=systemd:/\n" });
    expect(() => wrapProcessInMemoryCgroup(1, 1024, ops)).toThrow(MemoryBoundError);
    expect(() => wrapProcessInMemoryCgroup(1, 1024, ops)).toThrow(/cgroup v2/i);
  });

  it("removes a partially-created cgroup when attaching the pid fails", () => {
    const base = fakeOps({
      selfCgroup: SELF,
      subtreeControl: { [PARENT]: "cpu memory pids" },
    });
    // Writing memory.max succeeds but moving the pid fails (e.g. no permission)
    // -> the child cgroup must not be left behind.
    const ops: MemoryBoundOps = {
      ...base.ops,
      writeFileSync: (p: string, data: string) => {
        if (p.endsWith("cgroup.procs")) throw new Error("EPERM: operation not permitted");
        base.ops.writeFileSync(p, data);
      },
    };
    expect(() => wrapProcessInMemoryCgroup(11, 1024, ops)).toThrow(MemoryBoundError);
    // The created child was cleaned up (no leak).
    expect(base.dirs.has(CHILD(11))).toBe(false);
  });

  it("reclaims a stale empty cgroup dir left by a previous crashed run", () => {
    const { ops } = fakeOps({
      selfCgroup: SELF,
      subtreeControl: { [PARENT]: "cpu memory pids" },
      preExistingDirs: [CHILD(21)],
    });
    // Would have been EEXIST without the reclaim.
    expect(() => wrapProcessInMemoryCgroup(21, 1024, ops)).not.toThrow();
  });

  it("rejects an invalid pid or limit (never a 0/negative bound)", () => {
    const { ops } = fakeOps({ selfCgroup: SELF, subtreeControl: { [PARENT]: "memory" } });
    expect(() => wrapProcessInMemoryCgroup(0, 1024, ops)).toThrow(MemoryBoundError);
    expect(() => wrapProcessInMemoryCgroup(1, 0, ops)).toThrow(MemoryBoundError);
    expect(() => wrapProcessInMemoryCgroup(1, -1, ops)).toThrow(MemoryBoundError);
  });
});

describe("releaseMemoryCgroup", () => {
  it("returns true when the cgroup is removed and false when it still exists", () => {
    const { ops, dirs } = fakeOps({
      selfCgroup: SELF,
      subtreeControl: { [PARENT]: "memory" },
      preExistingDirs: [CHILD(31)],
    });
    expect(releaseMemoryCgroup(CHILD(31), ops)).toBe(true);
    expect(dirs.has(CHILD(31))).toBe(false);
    // A second release of an absent cgroup reports failure (surfaced, not swallowed).
    expect(releaseMemoryCgroup(CHILD(31), ops)).toBe(false);
  });
});
