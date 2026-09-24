import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { InMemoryAuditLogger, JsonlAuditLogger, type AuditLogger } from "./audit/logger.js";
import { loadSandyConfig, type LoadedConfig } from "./config/loader.js";
import { mcpServersManifestSchema, type McpServersManifest } from "./config/schema.js";

/**
 * `sandy import` (docs/IMPORT_DESIGN.md) — URL- and file-driven MCP server
 * configuration.
 *
 * One pipeline, one trust gate: fetch → ingest → validate → stage → (apply).
 * The content is validated by the EXISTING `mcpServersManifestSchema`
 * (fail-closed, exit 3) — nothing is legal because a URL said so. Staging
 * never touches live config; only `--apply` promotes a staged entry, and it
 * re-runs the full config load as the final gate.
 *
 * v1 is the deterministic path only: the source must be a machine-readable
 * manifest in the native schema. Transcribing prose pages with an LLM
 * (`--auto`) is a documented follow-up — the core has no LLM client in v1.
 */

export class ImportError extends Error {
  /** Exit-code bucket: 2 = usage-class, 3 = config-class (fail-closed). */
  readonly code: 2 | 3;
  constructor(code: 2 | 3, message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

export interface ImportSource {
  url?: string;
  file?: string;
  stdin?: boolean;
}

export interface ImportFetchResult {
  text: string;
  /** Size of the ingested body in bytes. */
  bytes: number;
  /** The URL after any redirects were followed. */
  finalUrl: string;
}

export interface ImportFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
}

/**
 * Defaults for the one-shot import fetch: the only permitted deviation from
 * the zero-egress invariant. Bounded by a timeout, a body-size cap, and a
 * redirect cap; every dial is human-confirmed and audited.
 */
export const IMPORT_DEFAULTS: ImportFetchOptions = {
  timeoutMs: 30_000,
  maxBytes: 1_048_576,
  maxRedirects: 3,
};

/** The single default staging location, relative to the config directory (not the cwd). */
export const DEFAULT_STAGE_DIR = ".sandy-import";

export interface StagedImport {
  /** Path of the staged file (`.sandy-import/<sha256>.json`). */
  path: string;
  /** sha256 of the ingested source bytes — the pin; the URL is a source at time T, not a live channel. */
  hash: string;
  /** ISO-8601 fetch time. */
  fetchedAt: string;
  /** The source (URL as fetched, or the file path / `<stdin>`). */
  source: string;
  /** The validated manifest content (after any `--tools` filtering). */
  manifest: McpServersManifest;
  /** Exact `sandbox.allowed_network` entries to add (remote servers only). */
  networkLines: string[];
  /** Environment variable NAMES the staged servers reference (never values). */
  envNames: string[];
  /** The allowlist review, per staged server. */
  questions: Array<{ server: string; exposed: string[]; allowed: string[] }>;
}

export interface ImportResult {
  staged: string;
  hash: string;
  source: string;
  applied: boolean;
  review: {
    servers: Array<{ name: string; transport: string; allowedTools: string[]; exposedCount: number }>;
    networkLines: string[];
    envNames: string[];
  };
}

export interface ImportOptions {
  /** Path to `sandy.json` (needed for `--apply`; staging is config-free). */
  configPath?: string;
  /**
   * Staging directory. An explicit value is used verbatim (relative to the
   * cwd). When omitted, the default is `.sandy-import` inside the CONFIG
   * directory (mirroring `report_output_dir`), not the cwd.
   */
  stageDir?: string;
  /** Audit logger to record `import_fetch` / `import_staged` events. */
  audit?: AuditLogger;
  /** Skip the fetch confirmation prompt. */
  yes?: boolean;
  /** Promote the staged entry into live config (the only path that does). */
  apply?: boolean;
  /** `server` → explicit `allowed_tools`; each tool must be in that server's `capabilities`. */
  tools?: Record<string, string[]>;
  /** Test seam: the dial (default: bounded fetch with redirect cap). */
  fetcher?: (url: string, opts: ImportFetchOptions) => Promise<ImportFetchResult>;
  /** Test seam: the confirmation prompt (default: read one line from stdin). */
  confirm?: () => Promise<boolean>;
  /** Test seam: the clock. */
  now?: () => Date;
}

// --- Fetch ------------------------------------------------------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The one-shot import fetch: http(s) only, ≤ `maxRedirects` hops (each hop
 * re-validated by URL parse before the dial), a hard timeout, and a running
 * body-size cap. The human confirmation happens BEFORE this is ever called —
 * this function is the dial itself, not the decision.
 */
export async function fetchImportManifest(
  url: string,
  opts: ImportFetchOptions = IMPORT_DEFAULTS,
): Promise<ImportFetchResult> {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (hop > opts.maxRedirects) {
      throw new ImportError(2, `too many redirects (max ${opts.maxRedirects}) fetching ${url}`);
    }
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new ImportError(2, `not a valid URL: ${current}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ImportError(2, `import fetch only supports http/https (got ${parsed.protocol})`);
    }
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ImportError(2, `fetch failed for ${current}: ${msg}`);
    }
    if (REDIRECT_STATUSES.has(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new ImportError(2, `redirect ${res.status} from ${current} has no Location`);
      try {
        current = new URL(loc, current).toString();
      } catch {
        throw new ImportError(2, `invalid redirect Location from ${current}: ${loc}`);
      }
      continue;
    }
    if (res.status !== 200) {
      throw new ImportError(2, `fetch failed: HTTP ${res.status} for ${current}`);
    }
    const { text, bytes } = await readBodyWithCap(res, opts.maxBytes, current);
    return { text, bytes, finalUrl: current };
  }
}

async function readBodyWithCap(
  res: Response,
  maxBytes: number,
  where: string,
): Promise<{ text: string; bytes: number }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) throw new ImportError(2, `response from ${where} exceeds ${maxBytes} bytes`);
    return { text, bytes };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new ImportError(2, `response from ${where} exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(concatBytes(chunks));
  return { text, bytes: total };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// --- Confirmation -------------------------------------------------------------

/**
 * Ask the operator to confirm the one-shot dial (default answer: NO). Reads
 * one line from stdin; EOF or anything but y/yes aborts.
 */
export function confirmFetch(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false);
      return;
    }
    process.stdout.write("Proceed? [y/N] ");
    let buf = "";
    const onData = (chunk: string): void => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      finish(buf.slice(0, nl));
    };
    const onEnd = (): void => finish(buf);
    const finish = (line: string): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
      const answer = line.trim().toLowerCase();
      resolve(answer === "y" || answer === "yes");
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.resume();
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// --- Validation + staging -----------------------------------------------------

/**
 * Parse + validate ingested content against the EXISTING manifest schema
 * (fail-closed, code 3). v1 is deterministic-only: prose is rejected with a
 * pointer to the documented follow-up, never silently half-processed.
 */
export function parseAndValidateManifest(
  text: string,
  origin: string,
): McpServersManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ImportError(
      3,
      `content from ${origin} is not valid JSON: ${(err as Error).message}. ` +
        "v1 import is deterministic-only (machine-readable manifests); transcribing prose pages (--auto) is not implemented yet.",
    );
  }
  const result = mcpServersManifestSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((iss) => `  - ${iss.path.join(".") || "(root)"}: ${iss.message}`)
      .join("\n");
    throw new ImportError(3, `invalid MCP server manifest from ${origin}:\n${issues}`);
  }
  return result.data;
}

/**
 * Apply `--tools` filtering: the explicit list becomes `allowed_tools`.
 * Fail-closed on an unknown server or a tool outside that server's
 * capabilities; the result must stay non-empty. Never auto-expands — a
 * server without an explicit list keeps exactly what the manifest declared.
 */
function applyToolsFilter(
  manifest: McpServersManifest,
  tools: Record<string, string[]> | undefined,
): McpServersManifest {
  if (!tools || Object.keys(tools).length === 0) return manifest;
  const servers = manifest.servers.map((server) => {
    const explicit = tools[server.name];
    if (explicit === undefined) return server;
    if (explicit.length === 0) {
      throw new ImportError(
        3,
        `--tools names no tools for server "${server.name}" (allowed_tools must be non-empty)`,
      );
    }
    const caps = new Set(server.capabilities);
    for (const tool of explicit) {
      if (!caps.has(tool)) {
        throw new ImportError(
          3,
          `--tools names tool "${tool}", which is not in server "${server.name}"'s capabilities (${server.capabilities.join(", ")})`,
        );
      }
    }
    return { ...server, allowed_tools: [...new Set(explicit)] };
  });
  return { servers };
}

/** Compute the exact `allowed_network` entries for remote servers (same port-reconstruction rule as endpointMatches). */
function computeNetworkLines(servers: McpServersManifest["servers"]): string[] {
  const lines: string[] = [];
  for (const server of servers) {
    if (server.transport === "stdio") continue;
    const url = new URL(server.url);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const line = `${url.hostname}:${port}`;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

/** Collect environment variable NAMES referenced by a manifest (never values). */
function computeEnvNames(manifest: McpServersManifest): string[] {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const m = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(value);
      if (m) names.add(m[1]!);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(manifest);
  return [...names].sort();
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface StagedFileContent {
  source: { url: string; sha256: string; fetchedAt: string };
  manifest: McpServersManifest;
}

async function stage(
  text: string,
  source: string,
  manifest: McpServersManifest,
  opts: ImportOptions,
): Promise<StagedImport> {
  const hash = sha256Hex(text);
  const fetchedAt = (opts.now ?? (() => new Date()))().toISOString();
  // The DEFAULT staging dir anchors to the config dir (not the process cwd),
  // mirroring how `report_output_dir` resolves (config/loader.ts): staging a
  // config is a property of that config, so a run from any directory lands its
  // `.sandy-import/` next to `sandy.json` rather than leaving a stray dir in cwd.
  // An EXPLICIT `stageDir` override is honored verbatim (cwd-relative if given
  // as a relative path). This is computed from the *declared* config path
  // (opts.configPath ?? $SANDY_CONFIG ?? "sandy.json") — it needs no config to
  // be loadable, preserving the config-free staging path.
  const configPath = opts.configPath ?? process.env["SANDY_CONFIG"] ?? "sandy.json";
  const configDir = path.dirname(path.resolve(configPath));
  const stageDir =
    opts.stageDir !== undefined
      ? path.resolve(opts.stageDir)
      : path.resolve(configDir, DEFAULT_STAGE_DIR);
  const stagedPath = path.join(stageDir, `${hash}.json`);
  const content: StagedFileContent = {
    source: { url: source, sha256: hash, fetchedAt },
    manifest,
  };
  await mkdir(stageDir, { recursive: true });
  await writeFile(stagedPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  return {
    path: stagedPath,
    hash,
    fetchedAt,
    source,
    manifest,
    networkLines: computeNetworkLines(manifest.servers),
    envNames: computeEnvNames(manifest),
    questions: manifest.servers.map((s) => ({
      server: s.name,
      exposed: [...s.capabilities],
      allowed: [...s.allowed_tools],
    })),
  };
}

// --- Apply --------------------------------------------------------------------

/**
 * The only path that touches live config. Requires a loadable config
 * (fail-closed if absent/broken — apply can't compute what it merges into),
 * refuses name collisions, merges (preserving the existing entries' order and
 * the file's JSON style), and re-runs the FULL config load as the final gate
 * before the result ships.
 */
async function applyStaged(staged: StagedImport, opts: ImportOptions): Promise<void> {
  const configPath = opts.configPath ?? process.env["SANDY_CONFIG"] ?? "sandy.json";
  let loaded: LoadedConfig;
  try {
    loaded = await loadSandyConfig(configPath);
  } catch (err) {
    throw new ImportError(3, `cannot apply: ${(err instanceof Error ? err.message : String(err))}`);
  }
  for (const server of staged.manifest.servers) {
    if (loaded.manifest.servers.some((s) => s.name === server.name)) {
      throw new ImportError(
        3,
        `server "${server.name}" already exists in ${loaded.manifestPath} — import refuses to overwrite existing servers`,
      );
    }
  }
  // Merge the manifest, preserving existing entries' key order (JSON.parse
  // keeps string-key order) and the file's 2-space style.
  const rawManifest = JSON.parse(await readFile(loaded.manifestPath, "utf8")) as {
    servers: unknown[];
  };
  rawManifest.servers.push(...staged.manifest.servers);
  await writeFile(loaded.manifestPath, `${JSON.stringify(rawManifest, null, 2)}\n`, "utf8");
  // Merge the computed allowed_network entries into sandy.json (deduped).
  if (staged.networkLines.length > 0) {
    const rawMain = JSON.parse(await readFile(configPath, "utf8")) as {
      sandbox: { allowed_network?: string[] };
    };
    const existing = rawMain.sandbox.allowed_network ?? [];
    const additions = staged.networkLines.filter((line) => !existing.includes(line));
    if (additions.length > 0) {
      rawMain.sandbox.allowed_network = [...existing, ...additions];
      await writeFile(configPath, `${JSON.stringify(rawMain, null, 2)}\n`, "utf8");
    }
  }
  // Final gate: the merged config must load cleanly (VPN-02 cross-check,
  // env refs, schema) — fail-closed, never ship a broken config.
  try {
    await loadSandyConfig(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ImportError(3, `applied config does not validate (fail-closed): ${msg}`);
  }
}

// --- Entry point ----------------------------------------------------------------

/**
 * Run the import pipeline: fetch → ingest → validate → stage → (apply).
 * Staging is config-free; `--apply` additionally requires a valid config.
 */
export async function runImport(source: ImportSource, opts: ImportOptions = {}): Promise<ImportResult> {
  const audit = opts.audit ?? new InMemoryAuditLogger();
  let text: string;
  let origin: string;
  if (source.url !== undefined) {
    const doConfirm = opts.confirm ?? confirmFetch;
    process.stderr.write(`sandy import: will dial (one-shot, audited) GET ${source.url}\n`);
    if (!(opts.yes === true ? true : await doConfirm())) {
      throw new ImportError(2, "import cancelled (fetch not confirmed)");
    }
    const doFetch = opts.fetcher ?? fetchImportManifest;
    let fetched: ImportFetchResult;
    try {
      fetched = await doFetch(source.url, IMPORT_DEFAULTS);
    } catch (err) {
      // A failed fetch may still have dialed out (DNS, TLS, an HTTP error
      // status, an oversize body): the egress exception is audited either way.
      audit.append("import_fetch", { url: source.url, outcome: "error", error: (err as Error).message });
      throw err;
    }
    audit.append("import_fetch", { url: source.url, outcome: "ok", finalUrl: fetched.finalUrl, sha256: sha256Hex(fetched.text), bytes: fetched.bytes });
    text = fetched.text;
    origin = fetched.finalUrl;
  } else if (source.stdin === true) {
    text = await readAllStdin();
    origin = "<stdin>";
  } else if (source.file !== undefined) {
    text = await readFile(source.file, "utf8").catch((err) => {
      throw new ImportError(2, `cannot read import source ${source.file}: ${(err as Error).message}`);
    });
    origin = source.file;
  } else {
    throw new ImportError(2, "no import source given (url, file, or - for stdin)");
  }

  const validated = parseAndValidateManifest(text, origin);
  const manifest = applyToolsFilter(validated, opts.tools);
  const staged = await stage(text, origin, manifest, opts);

  const applied = opts.apply === true;
  if (applied) {
    await applyStaged(staged, opts);
  }
  audit.append("import_staged", {
    path: staged.path,
    sha256: staged.hash,
    servers: manifest.servers.map((s) => s.name),
    applied,
  });

  return {
    staged: staged.path,
    hash: staged.hash,
    source: origin,
    applied,
    review: {
      servers: manifest.servers.map((s) => ({
        name: s.name,
        transport: s.transport,
        allowedTools: s.allowed_tools,
        exposedCount: s.capabilities.length,
      })),
      networkLines: staged.networkLines,
      envNames: staged.envNames,
    },
  };
}
