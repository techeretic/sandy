import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";

export interface DetectionContext {
  env: Readonly<Record<string, string | undefined>>;
  /** Injected for tests. */
  fileExists: (path: string) => boolean;
  readFileSync: (path: string) => string;
  /** `process.platform`; the macOS Seatbelt probe runs only on "darwin". */
  platform?: string;
  /**
   * macOS only: is a Seatbelt (`sandbox-exec`) profile in force? Injected for
   * tests; the default is {@link probeSeatbelt}.
   */
  seatbeltProbe?: () => boolean;
}

export type DetectedRuntime =
  | "docker"
  | "firejail"
  | "wsl"
  | "gvisor"
  | "k8s-pod"
  | "systemd-nspawn"
  | "chroot"
  | "macos-sandbox-exec"
  | "windows-appcontainer"
  | "none";

/**
 * Runtimes the config schema accepts but no detector recognizes yet. A config
 * declaring one can never match a detection, so it is refused at startup with
 * a pointer to `custom` (the operator-managed boundary) instead.
 */
export const UNDETECTABLE_RUNTIMES: readonly string[] = ["systemd-nspawn", "chroot", "windows-appcontainer"];

export interface RuntimeDetection {
  runtime: DetectedRuntime;
  /** Evidence for the detection, for the startup report. */
  evidence: string[];
}

const defaultContext = (): DetectionContext => ({
  env: process.env,
  fileExists: existsSync,
  readFileSync: (p) => readFileSync(p, "utf8"),
  platform: process.platform,
  seatbeltProbe: probeSeatbelt,
});

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Probe for a macOS Seatbelt boundary. The kernel refuses to apply a sandbox
 * to a process that is already running under a restrictive one, so a child
 * `sandbox-exec` with a no-op profile fails with `sandbox_apply: Operation
 * not permitted` exactly when a profile with at least one deny rule is in
 * force. (A profile that denies nothing lets the nested apply through — and
 * is no boundary, so reporting "none" for it is the honest answer.) Evidence
 * must match both the exit code and the message; anything else — including
 * a missing `sandbox-exec` — is "not detected", which fails closed.
 */
export function probeSeatbelt(): boolean {
  if (!existsSync(SANDBOX_EXEC)) return false;
  const res = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return res.status !== 0 && /sandbox_apply: Operation not permitted/.test(res.stderr ?? "");
}

function inWslKernel(ctx: DetectionContext): boolean {
  const release = ctx.env["WSL_DISTRO_NAME"] !== undefined;
  if (release) return true;
  try {
    return /microsoft/i.test(ctx.readFileSync("/proc/sys/kernel/osrelease"));
  } catch {
    return false;
  }
}

function inGvisor(ctx: DetectionContext): boolean {
  if (ctx.env["KATA_CONTAINER"] === "true") return true;
  try {
    const stat = statSync("/dev/null");
    // gVisor's sentry reports device number 0x0000 on /dev/null.
    return (stat.dev & 0xffff) === 0x0000;
  } catch {
    return false;
  }
}

function inFirejail(ctx: DetectionContext): boolean {
  // Real firejail sets `container=firejail` (it does NOT set FIREJAIL=1 or
  // create /.firejail in all builds). Keep the FIREJAIL env + /.firejail
  // marker checks too: some builds/launch flags set those instead. Order here
  // matters — a firejail jail ON a Docker host must report firejail, so this
  // is checked before inDocker (whose cgroup/mountinfo heuristics would
  // otherwise win off the inherited host signals).
  return (
    ctx.env["FIREJAIL"] === "1" ||
    ctx.env["container"] === "firejail" ||
    ctx.fileExists("/.firejail")
  );
}

function inDocker(ctx: DetectionContext): boolean {
  const evidence: string[] = [];
  if (ctx.fileExists("/.dockerenv")) evidence.push("/.dockerenv present");
  if (ctx.env["container"] === "docker") evidence.push("container=docker");
  if (evidence.length > 0) return true;
  try {
    const cgroup = ctx.readFileSync("/proc/1/cgroup");
    if (/docker|kubepods|containerd/.test(cgroup)) {
      evidence.push("/proc/1/cgroup matches container runtime");
      return true;
    }
  } catch {
    // not readable; keep checking
  }
  try {
    const mountinfo = ctx.readFileSync("/proc/self/mountinfo");
    if (/docker|containerd/.test(mountinfo)) {
      evidence.push("/proc/self/mountinfo matches container runtime");
      return true;
    }
  } catch {
    // not readable
  }
  return evidence.length > 0;
}

/**
 * Detect the sandbox runtime we are currently running inside (SB-03).
 * Order matters: nested sandboxes report the outermost detectable one first.
 */
export function detectRuntime(ctx: DetectionContext = defaultContext()): RuntimeDetection {
  if (inGvisor(ctx)) return { runtime: "gvisor", evidence: ["gVisor sentry characteristics"] };
  if (inFirejail(ctx)) return { runtime: "firejail", evidence: ["FIREJAIL env or /.firejail marker"] };
  if (inDocker(ctx)) {
    if (ctx.env["KUBERNETES_SERVICE_HOST"] !== undefined) {
      return { runtime: "k8s-pod", evidence: ["container indicators + Kubernetes service env"] };
    }
    return { runtime: "docker", evidence: ["container indicators"] };
  }
  if (inWslKernel(ctx)) return { runtime: "wsl", evidence: ["Microsoft WSL kernel signature"] };
  if (ctx.platform === "darwin" && ctx.seatbeltProbe?.() === true) {
    return { runtime: "macos-sandbox-exec", evidence: ["nested sandbox_apply refused: a Seatbelt profile is in force"] };
  }
  return { runtime: "none", evidence: [] };
}

export function platformLabel(): string {
  return `${os.platform()}-${os.arch()}`;
}
