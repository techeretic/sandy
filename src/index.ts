export {
  ConfigError,
  SecretResolver,
  loadSandyConfig,
  parseEnvRef,
  type LoadedConfig,
} from "./config/loader.js";
export {
  envRefSchema,
  mcpServersManifestSchema,
  mcpServerSchema,
  sandyConfigSchema,
  type AuthConfig,
  type EnvRef,
  type LlmConfig,
  type McpServer,
  type McpServersManifest,
  type PolicyConfig,
  type PreferencesConfig,
  type SandboxConfig,
  type SandyConfig,
} from "./config/schema.js";
export {
  NetworkEgressError,
  NetworkGuard,
  type EndpointMatch,
} from "./sandbox/network.js";
export {
  SandboxViolationError,
  PathConfinement,
  type FsStat,
  type PathConfinementOptions,
  type ViolationReason,
} from "./sandbox/confinement.js";
export {
  detectRuntime,
  platformLabel,
  type DetectedRuntime,
  type DetectionContext,
  type RuntimeDetection,
} from "./sandbox/detect.js";
export {
  buildCapabilityManifest,
  probeCapabilities,
  type CapabilityLoss,
  type CapabilityManifest,
  type CapabilityReport,
  type SubprocessNeed,
} from "./sandbox/capabilities.js";
export {
  SandboxEnforcer,
  type SandboxEnforcerOptions,
} from "./sandbox/enforcer.js";
export {
  ManagedServer,
  type ManagedServerOptions,
} from "./mcp/managed-server.js";
export {
  McpClientManager,
  type ConnectResult,
  type HealthSummary,
} from "./mcp/manager.js";
export { createTransport, guardedFetch } from "./mcp/transports.js";
export {
  ConfirmationRequiredError,
  FileManager,
  FileOpError,
  NullFileAuditSink,
  type FileAuditSink,
  type FileMutationResult,
  type FileOpErrorReason,
  type FileOpOptions,
  type FileReadResult,
  type FileManagerOptions,
} from "./files/file-manager.js";
export {
  InMemoryJournal,
  type MutationJournal,
  type MutationOp,
  type MutationRecord,
  type ReverseMutation,
  type UndoResult,
} from "./files/journal.js";
export {
  compilePatterns,
  isIgnored,
  isIgnoredByPatterns,
} from "./files/ignore.js";
export {
  detectFormat,
  validateContent,
  SUPPORTED_FORMATS,
  type FileFormat,
} from "./files/format.js";
export {
  InMemoryAuditLogger,
  JsonlAuditLogger,
  logModelInvocation,
  mcpAuditSink,
  fileAuditSink,
  type AuditEvent,
  type AuditEventType,
  type AuditLogger,
} from "./audit/logger.js";
export {
  captureTranscript,
  transcriptToJSON,
  transcriptToMarkdown,
  type Transcript,
} from "./audit/transcript.js";
export {
  Orchestrator,
  type Claim,
  type GatherTask,
  type Gap,
  type OrchestratorOptions,
  type OrchestratorRequest,
  type OrchestratorResult,
  type ProgressEvent,
  type RenderReportInput,
} from "./orchestrator/orchestrator.js";
export {
  gatherTaskSchema,
  orchestratorRequestSchema,
  reportSpecSchema,
  toOrchestratorRequest,
  type OrchestratorRequestInput,
} from "./orchestrator/request.js";
export { renderMarkdownReport } from "./orchestrator/report.js";
export {
  createOrchestrator,
  type OrchestratorFactoryOptions,
} from "./orchestrator/factory.js";
export {
  ReadOnlyGate,
  logWriteAttempt,
  type WriteApprovalGate,
  type WriteDecision,
  type WriteTask,
} from "./orchestrator/write-gate.js";
export {
  createSandy,
  type Sandy,
  type SandyCheckReport,
  type SandyDeps,
} from "./sandy.js";
export {
  createLlmEngine,
  HostLlmEngine,
  LlamaCppEngine,
  RemoteEngine,
  StubEngine,
  type CreateLlmEngineOptions,
  type EngineState,
  type EngineStatus,
  type LlamaCppEngineOptions,
  type LlmEngine,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  type RemoteEngineOptions,
  type StubEngineOptions,
} from "./engine.js";
export { CLI_NAME, EXIT, runCli } from "./cli.js";
export {
  SandyPluginAPI,
  ToolInputError,
} from "./plugin/api.js";
export {
  ProgressCollector,
  SessionCache,
  type PluginSession,
  type SandyPluginOptions,
} from "./plugin/state.js";
export {
  createSandyMcpServer,
  startSandyMcpServer,
  type SandyMcpServerOptions,
} from "./plugin/mcp-server.js";
export {
  filesDeleteInput,
  filesListInput,
  filesMkdirInput,
  filesReadInput,
  filesRenameInput,
  filesWriteInput,
  fileOpFlagsShape,
  gatherTaskShape,
  gatherToolInput,
  modelUsageInput,
  modelUsageShape,
  reportToolInput,
  statusToolInput,
  type FilesListResult,
  type FilesMutateResult,
  type FilesReadResult,
  type GatherToolResult,
  type ModelUsageToolResult,
  type ReportToolResult,
  type StatusToolResult,
} from "./plugin/tools.js";
export { resolveRetryPolicy, withRetry, DEFAULT_RETRY } from "./mcp/retry.js";
export {
  McpCallError,
  NullAuditSink,
  type HealthState,
  type McpAuditSink,
  type McpCallFailureReason,
  type McpCallRecord,
  type McpClientOptions,
  type RetryPolicy,
  type ServerHealth,
  type TransportFactory,
} from "./mcp/types.js";
