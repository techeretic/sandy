import type { McpServersManifest, SandboxConfig } from "../config/schema.js";
import {
  probeCapabilities,
  buildCapabilityManifest,
  type CapabilityManifest,
  type CapabilityReport,
} from "./capabilities.js";
import { PathConfinement, SandboxViolationError } from "./confinement.js";
import { detectRuntime, type RuntimeDetection } from "./detect.js";

export interface SandboxEnforcerOptions {
  /** Injectable for tests. */
  detection?: () => RuntimeDetection;
  /** Injectable for tests: probe knobs passed through to probeCapabilities. */
  probe?: Parameters<typeof probeCapabilities>[1];
  /** Injectable for tests: confinement knobs. */
  confinement?: ConstructorParameters<typeof PathConfinement>[1];
}

/**
 * The startup boundary guard (SB-03/04/05).
 *
 * Construct once at process start. It:
 *  - detects which sandbox we are in,
 *  - builds the declarative capability manifest from config,
 *  - probes the environment and reports — not fails opaquely — any loss,
 *  - exposes the path enforcer that all filesystem work must go through.
 *
 * No capability is ever requested at runtime beyond what the manifest
 * declares (SB-05).
 */
export class SandboxEnforcer {
  readonly detection: RuntimeDetection;
  readonly manifest: CapabilityManifest;
  readonly report: CapabilityReport;
  readonly paths: PathConfinement;

  private constructor(
    detection: RuntimeDetection,
    manifest: CapabilityManifest,
    report: CapabilityReport,
    paths: PathConfinement,
  ) {
    this.detection = detection;
    this.manifest = manifest;
    this.report = report;
    this.paths = paths;
  }

  /**
   * Start the enforcer. Throws if we are not inside a sandbox (a policy
   * violation) — otherwise returns, possibly in degraded/reduced mode.
   */
  static async create(
    sandbox: SandboxConfig,
    mcp: McpServersManifest,
    options: SandboxEnforcerOptions = {},
  ): Promise<SandboxEnforcer> {
    const detection = (options.detection ?? detectRuntime)();
    const manifest = buildCapabilityManifest(sandbox, mcp, detection);
    const report = probeCapabilities(manifest, options.probe);
    const paths = new PathConfinement(sandbox.allowed_paths, options.confinement);

    const declared = sandbox.runtime;

    // SB-03: refuse to operate without a boundary, unless the platform team
    // explicitly declared a custom boundary they manage themselves.
    if (detection.runtime === "none" && declared !== "custom") {
      throw new SandboxViolationError(
        "root-missing",
        "",
        "Sandy requires a sandbox boundary; none detected. Refusing to start.",
      );
    }

    // Fail closed on a declared/detected runtime mismatch: the config was
    // approved for one boundary, so we must not run under a different one.
    // A Kubernetes pod is docker-compatible.
    if (declared !== "custom" && detection.runtime !== "none" && declared !== detection.runtime) {
      const compatible = declared === "docker" && detection.runtime === "k8s-pod";
      if (!compatible) {
        throw new SandboxViolationError(
          "root-missing",
          "",
          `config declares sandbox runtime "${declared}" but the detected runtime is "${detection.runtime}". Refusing to start.`,
        );
      }
    }

    return new SandboxEnforcer(detection, manifest, report, paths);
  }

  /** True if we lost any declared capability (running reduced). */
  get degraded(): boolean {
    return this.report.degraded;
  }
}

export type { CapabilityManifest, CapabilityReport };
