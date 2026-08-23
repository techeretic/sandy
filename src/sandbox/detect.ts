import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";

export interface DetectionContext {
  env: Readonly<Record<string, string | undefined>>;
  /** Injected for tests. */
  fileExists: (path: string) => boolean;
  readFileSync: (path: string) => string;
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

export interface RuntimeDetection {
  runtime: DetectedRuntime;
  /** Evidence for the detection, for the startup report. */
  evidence: string[];
}

const defaultContext = (): DetectionContext => ({
  env: process.env,
  fileExists: existsSync,
  readFileSync: (p) => readFileSync(p, "utf8"),
});

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
  return { runtime: "none", evidence: [] };
}

export function platformLabel(): string {
  return `${os.platform()}-${os.arch()}`;
}
