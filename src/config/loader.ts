import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  mcpServersManifestSchema,
  sandyConfigSchema,
  type EnvRef,
  type McpServersManifest,
  type SandyConfig,
} from "./schema.js";
import { endpointMatches } from "../sandbox/network.js";
import { REPORT_FORMATS, type ReportFormat } from "../orchestrator/report.js";
import { loadTemplateRegistry, type TemplateRegistry } from "../orchestrator/templates.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function formatIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

export function parseEnvRef(ref: EnvRef): string {
  const match = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(ref);
  if (!match) throw new ConfigError(`invalid environment reference: ${ref}`);
  return match[1] as string;
}

export class SecretResolver {
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.env = env;
  }

  /** Resolve an env ref to its value. Call only at the point of use — never at load time. */
  resolve(ref: EnvRef): string {
    const name = parseEnvRef(ref);
    const value = this.env[name];
    if (value === undefined || value === "") {
      throw new ConfigError(
        `environment variable ${name} is not set (required by config); refusing to start`,
      );
    }
    return value;
  }

  /** Fail-closed check that every referenced variable is present. */
  check(refs: Iterable<EnvRef | undefined | null>): string[] {
    const missing: string[] = [];
    for (const ref of refs) {
      if (!ref) continue;
      const name = parseEnvRef(ref);
      if (this.env[name] === undefined || this.env[name] === "") {
        missing.push(name);
      }
    }
    return [...new Set(missing)];
  }
}

export interface LoadedConfig {
  /** Validated main config. Secret fields contain "${VAR}" refs, never values. */
  config: SandyConfig;
  /** Validated MCP server manifest. */
  manifest: McpServersManifest;
  /** Directory containing sandy.json — used to resolve relative paths. */
  configDir: string;
  /** Absolute path to the resolved MCP server manifest. */
  manifestPath: string;
  /** Absolutized report output directory. */
  reportOutputDir: string;
  /**
   * The report format to render (`preferences.default_report_format`, issue
   * #14), narrowed to the formats the renderer can actually produce. The
   * loader refuses an unimplemented format fail-closed, so this is always a
   * format `renderReport` accepts.
   */
  reportFormat: ReportFormat;
  /**
   * The validated template registry (issue #15 / RG-08), when `templates.path`
   * is configured. The loader fails closed on an unreadable/invalid registry,
   * so this is always a well-formed set of named saved requests.
   */
  templates?: TemplateRegistry;
  resolveSecret: (ref: EnvRef) => string;
}

interface EnvRefCollector {
  refs: Set<EnvRef>;
  visit: (value: unknown) => void;
}

function collectEnvRefs(value: unknown, collector: EnvRefCollector): void {
  if (typeof value === "string") {
    if (/^\$\{[A-Z][A-Z0-9_]*\}$/.test(value)) collector.refs.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collector.visit(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collector.visit(item);
  }
}

export async function loadSandyConfig(
  sandyPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LoadedConfig> {
  const rawMain = await readFile(sandyPath, "utf8").catch((err) => {
    throw new ConfigError(`cannot read config file ${sandyPath}: ${(err as Error).message}`);
  });

  let mainJson: unknown;
  try {
    mainJson = JSON.parse(rawMain);
  } catch (err) {
    throw new ConfigError(`config file ${sandyPath} is not valid JSON: ${(err as Error).message}`);
  }

  const mainResult = sandyConfigSchema.safeParse(mainJson);
  if (!mainResult.success) {
    throw new ConfigError(`invalid sandy config at ${sandyPath}:\n${formatIssues(mainResult.error)}`);
  }
  const config = mainResult.data;

  // Fail closed on an unimplemented report format (issue #14): the schema
  // accepts markdown|html|docx|xlsx|pdf, but only the first two are rendered.
  // An unimplemented format is a config error, never a silent Markdown fallback.
  const requestedFormat = config.preferences?.default_report_format ?? "markdown";
  if (!(REPORT_FORMATS as readonly string[]).includes(requestedFormat)) {
    throw new ConfigError(
      `invalid preferences.default_report_format: "${requestedFormat}" is not supported yet (supported: ${REPORT_FORMATS.join(", ")}). Refusing to start (fail-closed).`,
    );
  }
  const reportFormat = requestedFormat as ReportFormat;

  const configDir = path.dirname(path.resolve(sandyPath));
  const manifestPath = path.isAbsolute(config.mcp_servers)
    ? config.mcp_servers
    : path.resolve(configDir, config.mcp_servers);

  const rawManifest = await readFile(manifestPath, "utf8").catch((err) => {
    throw new ConfigError(
      `cannot read MCP server manifest ${manifestPath}: ${(err as Error).message}`,
    );
  });

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(rawManifest);
  } catch (err) {
    throw new ConfigError(
      `MCP server manifest ${manifestPath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  const manifestResult = mcpServersManifestSchema.safeParse(manifestJson);
  if (!manifestResult.success) {
    throw new ConfigError(
      `invalid MCP server manifest at ${manifestPath}:\n${formatIssues(manifestResult.error)}`,
    );
  }
  const manifest = manifestResult.data;

  for (const server of manifest.servers) {
    if (server.transport !== "sse" && server.transport !== "http") continue;
    const url = new URL(server.url);
    if (!config.sandbox.allowed_network.some((entry) => endpointMatches(entry, url))) {
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      throw new ConfigError(
        `MCP server "${server.name}" targets ${url.hostname}:${port}, which is not in sandbox.allowed_network (VPN-02: egress restricted to declared endpoints)`,
      );
    }
  }

  // Template registry (issue #15 / RG-08): an optional sidecar of named saved
  // requests. Loaded and validated here — fail-closed, like the manifest — so
  // every entry point (CLI, API) sees the same well-formed registry. A bad
  // registry is a config error (ConfigError), same as a bad manifest.
  let templates: TemplateRegistry | undefined;
  if (config.templates?.path !== undefined) {
    const templatesPath = path.isAbsolute(config.templates.path)
      ? config.templates.path
      : path.resolve(configDir, config.templates.path);
    try {
      templates = await loadTemplateRegistry(templatesPath);
    } catch (err) {
      // loadTemplateRegistry's message already names the file + the issue.
      throw new ConfigError(`invalid template registry (templates.path): ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const [name, request] of Object.entries(templates)) {
      for (const task of request.gather) {
        const server = manifest.servers.find((s) => s.name === task.server);
        if (!server) {
          throw new ConfigError(
            `template "${name}" references unknown server "${task.server}" (legal servers: ${manifest.servers.map((s) => s.name).join(", ")}). Refusing to start (fail-closed).`,
          );
        }
        if (!server.allowed_tools.includes(task.tool)) {
          throw new ConfigError(
            `template "${name}" references tool "${task.tool}", which is not allowed on server "${task.server}" (legal tools: ${server.allowed_tools.join(", ")}). Refusing to start (fail-closed).`,
          );
        }
      }
    }
  }

  const collector: EnvRefCollector = { refs: new Set(), visit: (v) => collectEnvRefs(v, collector) };
  collector.visit(config);
  collector.visit(manifest);

  const resolver = new SecretResolver(env);
  const missing = resolver.check(collector.refs);
  if (missing.length > 0) {
    throw new ConfigError(
      `required environment variable(s) not set: ${missing.join(", ")}. Refusing to start (fail-closed).`,
    );
  }

  const reportOutputDir = path.isAbsolute(config.report_output_dir)
    ? config.report_output_dir
    : path.resolve(configDir, config.report_output_dir);

  return {
    config,
    manifest,
    configDir,
    manifestPath,
    reportOutputDir,
    reportFormat,
    ...(templates !== undefined ? { templates } : {}),
    resolveSecret: (ref) => resolver.resolve(ref),
  };
}
