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
  writeAllowlistEntrySchema,
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
  endpointMatches,
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
  callSignature,
  Orchestrator,
  type Claim,
  type GatherTask,
  type Gap,
  type OrchestratorOptions,
  type OrchestratorRequest,
  type OrchestratorResult,
  type ProgressEvent,
  type RenderReportInput,
  type WriteResult,
} from "./orchestrator/orchestrator.js";
export {
  gatherTaskSchema,
  orchestratorRequestSchema,
  reportSpecSchema,
  toOrchestratorRequest,
  type OrchestratorRequestInput,
} from "./orchestrator/request.js";
export {
  legalToolCatalog,
  loadTemplateRegistry,
  parseRunBody,
  resolveTemplate,
  templateRegistrySchema,
  TemplateError,
  validateRequest,
  type TemplateRegistry,
} from "./orchestrator/templates.js";
export {
  REPORT_FORMATS,
  reportFormatExtension,
  renderHtmlReport,
  renderMarkdownReport,
  renderReport,
  type ReportFormat,
} from "./orchestrator/report.js";
export {
  createOrchestrator,
  type OrchestratorFactoryOptions,
} from "./orchestrator/factory.js";
export {
  logWriteAttempt,
  PolicyApprovalGate,
  ReadOnlyGate,
  type PolicyApprovalGateOptions,
  type WriteAllowlistEntry,
  type WriteApproval,
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
  threadsForCpuPercent,
  HostLlmEngine,
  LlamaCppEngine,
  RemoteEngine,
  StubEngine,
  type CreateLlmEngineOptions,
  type EngineMemoryStatus,
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
export {
  MemoryBoundError,
  defaultMemoryBoundOps,
  releaseMemoryCgroup,
  wrapProcessInMemoryCgroup,
  type MemoryBoundOps,
  type MemoryBoundResult,
} from "./memory-bound.js";
export {
  AutonomousLoop,
  NoModelEngineError,
  replanDecisionSchema,
  type AutonomousLoopOptions,
  type LoopResult,
  type ToolRef,
} from "./standalone/loop.js";
export {
  ApiError,
  BoundedJobStore,
  LocalApi,
  LoopbackBindError,
  createLocalApi,
  type Job,
  type JobKind,
  type JobStatus,
  type LocalApiOptions,
} from "./standalone/api.js";
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
  writeApprovalShape,
  writeTaskInput,
  writeToolInput,
  type FilesListResult,
  type FilesMutateResult,
  type FilesReadResult,
  type GatherToolResult,
  type ModelUsageToolResult,
  type ReportToolResult,
  type StatusToolResult,
  type WriteApprovalInput,
  type WriteTaskInput,
  type WriteTaskResult,
  type WriteToolResult,
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
