import { existsSync } from "node:fs";
import path from "node:path";
import type { McpServersManifest, SandboxConfig } from "../config/schema.js";
import type { RuntimeDetection } from "./detect.js";

export interface SubprocessNeed {
  /** Command to spawn (stdio MCP server). */
  argv: string[];
  /** Which MCP server it belongs to. */
  server: string;
}

/**
 * The full capability surface Sandy needs, derived from config (SB-04).
 * This is declarative and serializable so the platform team can review it.
 */
export interface CapabilityManifest {
  schema: "sandy.capability-manifest/v1";
  runtime: string;
  /** Filesystem roots the enforcer will confine to. */
  filesystemRoots: string[];
  /** Network endpoints allowed for egress (all flow via MCP). */
  networkEndpoints: string[];
  /** Subprocesses the sandbox must permit us to spawn. */
  subprocesses: SubprocessNeed[];
}

export interface CapabilityLoss {
  area: "filesystem" | "network" | "subprocess" | "runtime";
  detail: string;
}

export interface CapabilityReport {
  manifest: CapabilityManifest;
  /** True if anything declared was denied, i.e. we are running reduced. */
  degraded: boolean;
  /** What we lost, explicitly (never opaque). */
  lost: CapabilityLoss[];
  /** Human-readable summary for the startup banner. */
  summary: string;
}

export function buildCapabilityManifest(
  sandbox: SandboxConfig,
  mcp: McpServersManifest,
  detection: RuntimeDetection,
): CapabilityManifest {
  const subprocesses: SubprocessNeed[] = [];
  for (const server of mcp.servers) {
    if (server.transport === "stdio") {
      subprocesses.push({ argv: server.command, server: server.name });
    }
  }
  return {
    schema: "sandy.capability-manifest/v1",
    runtime: detection.runtime,
    filesystemRoots: sandbox.allowed_paths,
    networkEndpoints: sandbox.allowed_network,
    subprocesses,
  };
}

interface ProbeOptions {
  /** Injectable for tests; defaults to fs.existsSync. */
  fileExists?: (p: string) => boolean;
  /** Injectable for tests; returns resolved path or null if not found. */
  resolveCommand?: (cmd: string) => string | null;
}

/**
 * Probe what the running sandbox actually grants (SB-04).
 * Anything declared but unavailable becomes an explicit loss rather than a
 * silent failure. Network is not socket-probed: egress is structurally
 * confined to the MCP transport layer (SB-07), so network endpoints are
 * treated as granted-by-design and recorded, not dialed.
 */
export function probeCapabilities(manifest: CapabilityManifest, options: ProbeOptions = {}): CapabilityReport {
  const fileExists = options.fileExists ?? existsSync;
  const resolveCommand = options.resolveCommand ?? defaultResolveCommand;
  const lost: CapabilityLoss[] = [];

  if (manifest.runtime === "none") {
    lost.push({
      area: "runtime",
      detail: "no sandbox runtime detected; running unsandboxed is a policy violation — refusing to continue without a boundary",
    });
  }

  for (const root of manifest.filesystemRoots) {
    if (!fileExists(root)) {
      lost.push({ area: "filesystem", detail: `root not accessible: ${root}` });
    }
  }

  for (const sub of manifest.subprocesses) {
    const exe = path.basename(sub.argv[0] ?? "");
    if (exe && !sub.argv[0]?.includes("/") && resolveCommand(exe) === null) {
      lost.push({
        area: "subprocess",
        detail: `command not resolvable for MCP server "${sub.server}": ${sub.argv.join(" ")}`,
      });
    }
  }

  const degraded = lost.length > 0;
  return {
    manifest,
    degraded,
    lost,
    summary: degraded
      ? `reduced mode: ${lost.length} capability loss(es) — ${lost.map((l) => l.detail).join("; ")}`
      : `all declared capabilities granted (${manifest.filesystemRoots.length} root(s), ${manifest.networkEndpoints.length} endpoint(s), ${manifest.subprocesses.length} subprocess(es))`,
  };
}

function defaultResolveCommand(cmd: string): string | null {
  const PATH = process.env["PATH"] ?? "";
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    if (existsSync(path.join(dir, cmd))) return path.join(dir, cmd);
  }
  return null;
}
