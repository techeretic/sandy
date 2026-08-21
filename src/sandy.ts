import {
  loadSandyConfig,
  SecretResolver,
  type LoadedConfig,
} from "./config/loader.js";
import {
  SandboxEnforcer,
  type SandboxEnforcerOptions,
} from "./sandbox/enforcer.js";
import { NetworkGuard } from "./sandbox/network.js";
import {
  InMemoryAuditLogger,
  JsonlAuditLogger,
  mcpAuditSink,
  fileAuditSink,
  type AuditLogger,
} from "./audit/logger.js";
import {
  McpClientManager,
  type ConnectResult,
  type HealthSummary,
} from "./mcp/manager.js";
import { FileManager } from "./files/file-manager.js";
import type { MutationJournal } from "./files/journal.js";
import { createOrchestrator } from "./orchestrator/factory.js";
import type { Orchestrator } from "./orchestrator/orchestrator.js";
import { createLlmEngine, type LlmEngine } from "./engine.js";
import type {
  OrchestratorRequest,
  OrchestratorResult,
  ProgressEvent,
} from "./orchestrator/orchestrator.js";
import type { RetryPolicy, TransportFactory } from "./mcp/types.js";
import type { RuntimeDetection } from "./sandbox/detect.js";
import type { CapabilityLoss } from "./sandbox/capabilities.js";

export interface SandyDeps {
  /** Path to sandy.json. */
  sandyPath: string;
  /** Environment used for config + secret resolution. Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * If set, audit events persist to this JSONL file (append-only, AU-01).
   * If omitted, an in-memory logger is used (no disk side effect).
   */
  auditFile?: string;
  /**
   * Audit payload logging opt-in (AU-02). Defaults to the value in config
   * policy.audit_payload_logging.
   */
  auditPayloadLogging?: boolean;
  /** Injectable MCP transport factory (tests: in-memory servers). */
  transportFactory?: TransportFactory;
  /** Injectable runtime detection (tests). */
  detection?: () => RuntimeDetection;
  /** Injectable capability probe knobs (tests). */
  probe?: SandboxEnforcerOptions["probe"];
  /** Injectable path-confinement knobs (tests). */
  confinement?: SandboxEnforcerOptions["confinement"];
  /** Injectable LLM engine (tests / Phase 2). Default: from config's llm provider. */
  engine?: LlmEngine;
  /** MCP retry policy overrides. */
  retry?: Partial<RetryPolicy>;
  /** Per-request MCP timeout (ms). */
  requestTimeoutMs?: number;
  /** Orchestrator concurrency. Defaults to preferences.max_concurrent_mcp_calls. */
  concurrency?: number;
  /** Progress sink (Q4). */
  onProgress?: (event: ProgressEvent) => void;
  /** Mutation journal for the File Manager (undo, FM-05). */
  journal?: MutationJournal;
}

/** The capability/health snapshot surfaced by `sandy check`. */
export interface SandyCheckReport {
  /**
   * True only when the boundary is intact, nothing was lost, and every MCP
   * server connected. False is a *reported* degraded state, not a crash —
   * the details are in the fields below.
   */
  ok: boolean;
  config: {
    mode: string;
    configDir: string;
    manifestPath: string;
    reportOutputDir: string;
  };
  sandbox: {
    /** Declared runtime (from config). */
    declaredRuntime: string;
    /** Detected runtime (SB-03). */
    runtime: string;
    /** Evidence for the detection. */
    evidence: string[];
    /** Running reduced: a declared capability was denied. */
    degraded: boolean;
    /** What was lost, explicitly (never opaque). */
    lost: string[];
    /** One-line summary. */
    summary: string;
    allowedPaths: string[];
    allowedNetwork: string[];
  };
  mcp: {
    /** Servers that connected. */
    connected: string[];
    /** Servers that failed at startup (terminal, MCP-10). */
    failed: Array<{ server: string; error: string }>;
    /** Per-server health (MCP-09). */
    health: HealthSummary;
  };
}

/**
 * A fully-wired Sandy session: config → sandbox boundary → audit log → MCP
 * fleet → file manager → orchestrator. This is the spine the CLI and the
 * plugin both attach to.
 */
export interface Sandy {
  loaded: LoadedConfig;
  enforcer: SandboxEnforcer;
  audit: AuditLogger;
  /** The reasoning layer (PRD §7). Host engine in plugin mode; bundled in Phase 2. */
  engine: LlmEngine;
  manager: McpClientManager;
  files: FileManager;
  orchestrator: Orchestrator;
  /** Startup MCP connection result (ok / failed). */
  connectResult: ConnectResult;
  /** Capability + MCP health snapshot. */
  check(): SandyCheckReport;
  /** Execute an orchestrator request end-to-end (gather → report). */
  run(request: OrchestratorRequest): Promise<OrchestratorResult>;
  /** Close MCP connections and flush the audit log. Idempotent-safe. */
  close(): Promise<void>;
}

/**
 * Compose the modules into a runnable Sandy (the startup sequence).
 *
 * Fail-closed contract:
 *  - invalid config            → ConfigError (thrown)
 *  - no sandbox / runtime mismatch → SandboxViolationError (thrown)
 * A *degraded* but sandboxed state (a lost capability, a failed MCP server)
 * is NOT thrown — it is recorded and surfaced via {@link Sandy.check}.
 */
export async function createSandy(deps: SandyDeps): Promise<Sandy> {
  const env = deps.env ?? process.env;

  // 1. Config (CP-04): validate both files, cross-check egress, pre-flight
  //    secrets. Throws fail-closed on any problem.
  const loaded = await loadSandyConfig(deps.sandyPath, env);

  // 2. Sandbox boundary (SB-03/04/05): refuse unsandboxed / mismatch, then
  //    probe what the sandbox actually grants and report any loss.
  const enforcer = await SandboxEnforcer.create(loaded.config.sandbox, loaded.manifest, {
    detection: deps.detection,
    probe: deps.probe,
    confinement: deps.confinement,
  });

  // 3. Audit log (AU-01/02). Payload logging is opt-in and centralized here.
  const payloadLogging = deps.auditPayloadLogging ?? loaded.config.policy.audit_payload_logging;
  const audit: AuditLogger = deps.auditFile
    ? new JsonlAuditLogger(deps.auditFile, { auditPayloadLogging: payloadLogging })
    : new InMemoryAuditLogger({ auditPayloadLogging: payloadLogging });

  // Reduced mode is an audited fact, never a silent state (SB-04).
  if (enforcer.degraded) {
    audit.append("sandbox_violation", {
      detail: enforcer.report.summary,
      lost: enforcer.report.lost.map((l: CapabilityLoss) => `${l.area}: ${l.detail}`),
    });
  }

  // 3b. Reasoning layer (PRD §7). Host engine in plugin mode; a bundled/remote
  //     engine (Phase 2, SD-02/04) drops in behind the same LlmEngine seam.
  const engine = deps.engine ?? createLlmEngine(loaded.config.llm, audit);

  const mcpSink = mcpAuditSink(audit);
  const fileSink = fileAuditSink(audit);

  // 4. MCP fleet (MCP-03/04/10). All egress is confined to the declared
  //    endpoints via the NetworkGuard.
  const guard = new NetworkGuard(loaded.config.sandbox.allowed_network);
  const resolver = new SecretResolver(env);
  const manager = new McpClientManager(loaded.manifest.servers, resolver, guard, {
    retry: deps.retry,
    requestTimeoutMs: deps.requestTimeoutMs,
    audit: mcpSink,
    transportFactory: deps.transportFactory,
  });
  const connectResult = await manager.connectAll();

  // 5. Confined file operations (FM-*).
  const files = new FileManager({
    confinement: enforcer.paths,
    policy: loaded.config.policy,
    journal: deps.journal,
    audit: fileSink,
  });

  // 6. Orchestrator (RG-*), writing reports through the File Manager.
  const preferences = loaded.config.preferences;
  const orchestrator = createOrchestrator({
    manager,
    audit,
    files,
    reportDir: loaded.reportOutputDir,
    concurrency: deps.concurrency ?? preferences?.max_concurrent_mcp_calls,
    onProgress: deps.onProgress,
  });

  return {
    loaded,
    enforcer,
    audit,
    engine,
    manager,
    files,
    orchestrator,
    connectResult,
    check(): SandyCheckReport {
      const report = enforcer.report;
      return {
        ok: !enforcer.degraded && connectResult.failed.length === 0,
        config: {
          mode: loaded.config.mode,
          configDir: loaded.configDir,
          manifestPath: loaded.manifestPath,
          reportOutputDir: loaded.reportOutputDir,
        },
        sandbox: {
          declaredRuntime: loaded.config.sandbox.runtime,
          runtime: enforcer.detection.runtime,
          evidence: enforcer.detection.evidence,
          degraded: report.degraded,
          lost: report.lost.map((l) => `${l.area}: ${l.detail}`),
          summary: report.summary,
          allowedPaths: loaded.config.sandbox.allowed_paths,
          allowedNetwork: loaded.config.sandbox.allowed_network,
        },
        mcp: {
          connected: connectResult.ok,
          failed: connectResult.failed,
          health: manager.health(),
        },
      };
    },
    run(request: OrchestratorRequest): Promise<OrchestratorResult> {
      return orchestrator.run(request);
    },
    async close(): Promise<void> {
      await manager.close();
      await audit.close();
    },
  };
}
