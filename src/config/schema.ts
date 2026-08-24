import { z } from "zod";

/**
 * A value that must be resolved from the environment at runtime.
 * Sandy never stores literal secrets in config (MCP-08).
 */
export const envRefSchema = z
  .string()
  .regex(/^\$\{[A-Z][A-Z0-9_]*\}$/, {
    message:
      "secrets must reference an environment variable, e.g. \"${MY_API_KEY}\" — literal values are not allowed",
  })
  .describe("Environment variable reference: ${VAR_NAME}");

export const absolutePathSchema = z
  .string()
  .min(1)
  .refine((p) => p.startsWith("/"), { message: "must be an absolute path" })
  .refine(
    (p) => !p.split("/").includes(".."),
    { message: "must not contain '..' path segments" },
  )
  .describe("Absolute filesystem path, no '..' traversal");

const label = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
const endpointSchema = z
  .string()
  .regex(new RegExp(`^${label}(\\.${label})*(?::\\d{1,5})?$`, "i"), {
    message: "must be a hostname or hostname:port",
  })
  .describe("Network endpoint, e.g. internal.company.com:443");

const semverPinSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, {
    message: "must be an exact semver pin, e.g. 1.2.3",
  })
  .describe("Exact version pin for the MCP server (Q7: VCS-reviewed updates)");

const authSchema = z
  .object({
    type: z.enum(["bearer", "api_key", "oauth", "mtls"]),
    token: envRefSchema.optional(),
    client_id: z.string().min(1).optional(),
    client_secret: envRefSchema.optional(),
    token_url: z.string().url().optional(),
    ca_bundle_path: absolutePathSchema.optional(),
    client_cert_path: absolutePathSchema.optional(),
    client_key_path: absolutePathSchema.optional(),
  })
  .strict()
  .refine((a) => {
    if (a.type === "bearer" || a.type === "api_key") return a.token !== undefined;
    if (a.type === "oauth")
      return a.client_id !== undefined && a.token_url !== undefined;
    if (a.type === "mtls")
      return (
        a.ca_bundle_path !== undefined &&
        a.client_cert_path !== undefined &&
        a.client_key_path !== undefined
      );
    return false;
  }, {
    message:
      "auth fields do not match auth.type (bearer/api_key need token; oauth needs client_id+token_url; mtls needs all paths)",
  });

const stdioServerSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, { message: "must be kebab-case" })
      .describe("Unique server identifier"),
    transport: z.literal("stdio"),
    command: z
      .array(z.string().min(1))
      .min(1, { message: "stdio transport requires a command" })
      .describe("Executable and arguments"),
    env: z
      .record(z.string(), envRefSchema)
      .optional()
      .describe("Environment for the server process; values must be env refs"),
    version: semverPinSchema,
    capabilities: z.array(z.string().min(1)).min(1),
    allowed_tools: z
      .array(z.string().min(1))
      .min(1, { message: "must allow at least one tool (MCP-07)" }),
  })
  .strict();

const remoteServerSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, { message: "must be kebab-case" })
      .describe("Unique server identifier"),
    transport: z.enum(["sse", "http"]),
    url: z.string().url().describe("MCP server endpoint"),
    auth: authSchema.optional(),
    version: semverPinSchema,
    capabilities: z.array(z.string().min(1)).min(1),
    allowed_tools: z
      .array(z.string().min(1))
      .min(1, { message: "must allow at least one tool (MCP-07)" }),
  })
  .strict();

export const mcpServerSchema = z.discriminatedUnion("transport", [
  stdioServerSchema,
  remoteServerSchema,
]);

export const mcpServersManifestSchema = z
  .object({
    servers: z
      .array(mcpServerSchema)
      .min(1, { message: "at least one MCP server is required" })
      .refine(
        (servers) =>
          new Set(servers.map((s) => s.name)).size === servers.length,
        { message: "server names must be unique" },
      ),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    for (const server of manifest.servers) {
      const capSet = new Set(server.capabilities);
      for (const tool of server.allowed_tools) {
        if (!capSet.has(tool)) {
          ctx.addIssue({
            code: "custom",
            path: ["allowed_tools"],
            message: `tool "${tool}" is not in the server's declared capabilities`,
          });
        }
      }
    }
  });

const loopbackHostSchema = z
  .string()
  .refine(
    (h) => h === "127.0.0.1" || h === "localhost" || h === "::1",
    { message: "engine.host must be a loopback address (127.0.0.1, localhost, or ::1)" },
  )
  .default("127.0.0.1")
  .describe("Loopback-only bind address for the local model server");

const llmEngineSchema = z
  .object({
    type: z
      .enum(["llama-server", "openai-compatible"])
      .default("llama-server")
      .describe("Local model runtime"),
    command: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("Executable + args for the local model server; defaults to ['llama-server']"),
    host: loopbackHostSchema,
    port: z
      .number()
      .int()
      .min(0)
      .max(65535)
      .default(0)
      .describe("0 = pick a free loopback port"),
  })
  .strict();

const llmSchema = z
  .object({
    provider: z
      .enum(["local", "host", "remote"])
      .describe(
        "local: bundled model (standalone); host: Claude Code/Codex LLM (plugin); remote: configured endpoint",
      ),
    model: z.string().min(1).optional(),
    endpoint: z.string().url().optional(),
    api_key: envRefSchema.nullable().optional(),
    // Phase 2 (standalone, SD-02/04): where the model file lives and how to
    // start the local runtime. Additive — existing host/local configs keep
    // loading (both optional at the schema level; provider constraints below
    // decide when they're required).
    model_path: absolutePathSchema.optional(),
    engine: llmEngineSchema.optional(),
  })
  .strict()
  .refine((l) => {
    if (l.provider === "remote") return l.endpoint !== undefined;
    if (l.provider === "local") return l.model !== undefined && l.model_path !== undefined;
    return true;
  }, {
    message: "provider constraints not met (remote needs endpoint; local needs model + model_path)",
  });

const sandboxSchema = z
  .object({
    runtime: z.enum([
      "docker",
      "firejail",
      "wsl",
      "gvisor",
      "k8s-pod",
      "systemd-nspawn",
      "chroot",
      "macos-sandbox-exec",
      "windows-appcontainer",
      "custom",
    ]),
    allowed_paths: z
      .array(absolutePathSchema)
      .min(1, { message: "at least one allowed path (working root) is required" }),
    allowed_network: z.array(endpointSchema).default([]),
    max_memory_mb: z.number().int().positive(),
    max_cpu_percent: z.number().int().min(1).max(100),
  })
  .strict();

const policySchema = z
  .object({
    confirmation_required: z
      .array(z.enum(["delete", "overwrite", "rename", "create"]))
      .min(1)
      .default(["delete", "overwrite"]),
    undo_depth: z.number().int().nonnegative().default(0),
    dry_run_default: z.boolean().default(false),
    audit_payload_logging: z.boolean().default(false),
    ignore_patterns: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine(
    (p) => p.confirmation_required.includes("delete"),
    { message: 'policy must require confirmation for "delete" (FM-04: stricter, never looser)' },
  )
  .refine(
    (p) => p.confirmation_required.includes("overwrite"),
    { message: 'policy must require confirmation for "overwrite" (FM-04: stricter, never looser)' },
  );

const preferencesSchema = z
  .object({
    default_report_format: z
      .enum(["markdown", "html", "docx", "xlsx", "pdf"])
      .default("markdown"),
    max_concurrent_mcp_calls: z.number().int().min(1).max(100).default(5),
    stream_progress: z.boolean().default(true),
  })
  .strict()
  .optional();

/**
 * The admin write allowlist (issue #16 / Q6): the (server, tool) pairs a
 * write-back may target. Separate from, and STRICTER than, the read
 * allowlist (the manifest's `allowed_tools`) — CP-02: policy > preferences.
 * The loader cross-checks every entry against the manifest and fails closed
 * on an entry that names an unknown server or a non-allowed tool, so the
 * write allowlist can never be wider than the read allowlist. When absent
 * (or empty), no write is possible: the default gate refuses all writes.
 */
export const writeAllowlistEntrySchema = z
  .object({
    server: z.string().min(1).describe("MCP server name (must exist in the manifest)"),
    tool: z
      .string()
      .min(1)
      .describe("Tool name (must be in the server's allowed_tools)"),
  })
  .strict();

export type WriteAllowlistEntry = z.infer<typeof writeAllowlistEntrySchema>;

/**
 * The optional template registry (issue #15 / RG-08): a named sidecar file of
 * saved requests, the same shape `sandy run <request.json>` / `POST /run`
 * take. When absent, no templates are available (the CLI falls back to
 * treating the argument as a request file).
 */
export const templatesConfigSchema = z
  .object({
    path: z.string().min(1).describe("Path to the template registry (templates.json)"),
  })
  .strict()
  .optional();

export const sandyConfigSchema = z
  .object({
    mode: z.enum(["plugin", "standalone"]),
    llm: llmSchema,
    sandbox: sandboxSchema,
    mcp_servers: z
      .string()
      .min(1)
      .describe("Path to the MCP server manifest (mcp-servers.json)"),
    report_output_dir: z.string().min(1),
    policy: policySchema,
    preferences: preferencesSchema,
    templates: templatesConfigSchema,
    /**
     * The admin write allowlist (issue #16 / Q6). Optional; when absent,
     * write-back is unavailable (the default gate refuses all writes).
     */
    write_allowlist: z.array(writeAllowlistEntrySchema).optional(),
  })
  .strict();

export type EnvRef = z.infer<typeof envRefSchema>;
export type AuthConfig = z.infer<typeof authSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpServersManifest = z.infer<typeof mcpServersManifestSchema>;
export type LlmConfig = z.infer<typeof llmSchema>;
export type SandboxConfig = z.infer<typeof sandboxSchema>;
export type PolicyConfig = z.infer<typeof policySchema>;
export type PreferencesConfig = z.infer<typeof preferencesSchema>;
export type SandyConfig = z.infer<typeof sandyConfigSchema>;
