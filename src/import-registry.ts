/**
 * Deterministic conversion of an MCP Registry `server.json` into Sandy's
 * native manifest shape, for `sandy import` (docs/IMPORT_DESIGN.md, open
 * question "manifest conversion").
 *
 * The converter is a transcriber with no special powers: its output is a
 * CANDIDATE that still runs through the existing `mcpServersManifestSchema`
 * (exact-semver pin, env refs only, allowlist ⊆ capabilities). Anything it
 * cannot map without guessing is refused fail-closed (code 3), never
 * approximated:
 *
 *  - The registry format does not list a server's tools, so the allowlist
 *    must come from the operator (`--tools <name>=a,b`); the declared tools
 *    become both `capabilities` and `allowed_tools`.
 *  - When a server offers both a hosted remote and a local package, which one
 *    to use is an operator decision (a remote sends every query to a third
 *    party; a package runs locally) — `--registry-source remote|package`.
 *  - Remote headers, URL templates, unsupported registries or transports, and
 *    required arguments without a fixed value are refused.
 */

export type RegistrySource = "remote" | "package";

export class RegistryConversionError extends Error {}

interface RegistryArgument {
  type?: string;
  name?: string;
  value?: string;
  isRequired?: boolean;
}

interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  transport?: { type?: string };
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: Array<{ name?: string; isRequired?: boolean }>;
}

interface RegistryRemote {
  type?: string;
  url?: string;
  headers?: unknown[];
}

interface RegistryServerJson {
  name?: string;
  version?: string;
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

/** Runner command per supported package registry (the package's own `runtimeHint` is not trusted to pick an executable). */
const PACKAGE_RUNNERS: Record<string, (identifier: string, version: string) => string[]> = {
  npm: (id, v) => ["npx", "-y", `${id}@${v}`],
  pypi: (id, v) => ["uvx", `${id}==${v}`],
};

const REMOTE_TRANSPORTS: Record<string, "http" | "sse"> = {
  "streamable-http": "http",
  sse: "sse",
};

/**
 * Is this parsed JSON an MCP Registry `server.json` (and not a native
 * manifest)? A native manifest has a top-level `servers` array; a registry
 * entry has a `name` plus `packages` and/or `remotes`.
 */
export function isRegistryServerJson(json: unknown): json is RegistryServerJson {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return false;
  const o = json as Record<string, unknown>;
  if ("servers" in o) return false;
  return typeof o["name"] === "string" && (Array.isArray(o["packages"]) || Array.isArray(o["remotes"]));
}

/** The Sandy server name for a registry name: its last path segment, kebab-cased. */
export function registryServerName(registryName: string): string {
  const last = registryName.slice(registryName.lastIndexOf("/") + 1);
  const kebab = last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "");
  if (kebab.length === 0) {
    throw new RegistryConversionError(`cannot derive a server name from registry name "${registryName}"`);
  }
  return kebab;
}

/**
 * Convert a registry `server.json` into a native manifest candidate
 * (`{ servers: [entry] }`), or throw {@link RegistryConversionError}.
 */
export function convertRegistryServerJson(
  json: RegistryServerJson,
  tools: Record<string, string[]> | undefined,
  source: RegistrySource | undefined,
): { servers: unknown[] } {
  const name = registryServerName(json.name as string);
  const declared = tools?.[name];
  if (declared === undefined || declared.length === 0) {
    throw new RegistryConversionError(
      `"${json.name}" is an MCP Registry server.json, which does not list the server's tools. ` +
        `Declare the allowlist yourself: --tools ${name}=<tool1,tool2,...>`,
    );
  }
  const toolList = [...new Set(declared)];

  const remotes = json.remotes ?? [];
  const packages = json.packages ?? [];
  let chosen: RegistrySource;
  if (source !== undefined) {
    chosen = source;
  } else if (remotes.length > 0 && packages.length > 0) {
    throw new RegistryConversionError(
      `"${json.name}" offers both a hosted remote and a local package. Choose one: ` +
        "--registry-source remote (every call goes to the hosted endpoint, through Sandy's NetworkGuard) or " +
        "--registry-source package (the server runs locally as a stdio subprocess; its own egress is bounded by your sandbox).",
    );
  } else {
    chosen = remotes.length > 0 ? "remote" : "package";
  }

  const entry =
    chosen === "remote" ? remoteEntry(json, name, remotes) : packageEntry(json, name, packages);
  return { servers: [{ ...entry, capabilities: toolList, allowed_tools: toolList }] };
}

function remoteEntry(json: RegistryServerJson, name: string, remotes: RegistryRemote[]): Record<string, unknown> {
  const remote = remotes.find((r) => r.type !== undefined && r.type in REMOTE_TRANSPORTS);
  if (remote === undefined) {
    throw new RegistryConversionError(
      `"${json.name}" has no remote with a supported transport (${Object.keys(REMOTE_TRANSPORTS).join(", ")})`,
    );
  }
  if (typeof remote.url !== "string" || /[{}]/.test(remote.url)) {
    throw new RegistryConversionError(`remote URL for "${json.name}" is missing or templated; write this entry by hand`);
  }
  if (Array.isArray(remote.headers) && remote.headers.length > 0) {
    throw new RegistryConversionError(
      `remote for "${json.name}" declares headers; mapping them to an auth block would be a guess — write this entry by hand`,
    );
  }
  return {
    name,
    transport: REMOTE_TRANSPORTS[remote.type as string],
    url: remote.url,
    version: json.version,
  };
}

function packageEntry(json: RegistryServerJson, name: string, packages: RegistryPackage[]): Record<string, unknown> {
  const pkg = packages.find(
    (p) => p.registryType !== undefined && p.registryType in PACKAGE_RUNNERS && (p.transport?.type ?? "stdio") === "stdio",
  );
  if (pkg === undefined) {
    throw new RegistryConversionError(
      `"${json.name}" has no stdio package from a supported registry (${Object.keys(PACKAGE_RUNNERS).join(", ")})`,
    );
  }
  if (typeof pkg.identifier !== "string" || typeof pkg.version !== "string") {
    throw new RegistryConversionError(`package for "${json.name}" is missing its identifier or version`);
  }
  const runner = PACKAGE_RUNNERS[pkg.registryType as string] as (id: string, v: string) => string[];
  const [exe, ...runnerArgs] = runner(pkg.identifier, pkg.version);
  const command = [
    exe as string,
    ...argumentsOf(json, pkg.runtimeArguments),
    ...runnerArgs,
    ...argumentsOf(json, pkg.packageArguments),
  ];
  const env: Record<string, string> = {};
  for (const v of pkg.environmentVariables ?? []) {
    // Only required variables become env refs: an optional one keeps the
    // server's own default, and an unset ref would fail the config load.
    if (v.isRequired === true && typeof v.name === "string") env[v.name] = `\${${v.name}}`;
  }
  return {
    name,
    transport: "stdio",
    command,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    // The pin is the package's own version: it is what the command runs.
    version: pkg.version,
  };
}

function argumentsOf(json: RegistryServerJson, args: RegistryArgument[] | undefined): string[] {
  const out: string[] = [];
  for (const arg of args ?? []) {
    if (arg.value === undefined) {
      if (arg.isRequired === true) {
        throw new RegistryConversionError(
          `"${json.name}" has a required ${arg.type ?? ""} argument${arg.name ? ` ${arg.name}` : ""} with no fixed value; write this entry by hand`,
        );
      }
      continue;
    }
    if (arg.type === "named" && typeof arg.name === "string") out.push(arg.name, arg.value);
    else out.push(arg.value);
  }
  return out;
}
