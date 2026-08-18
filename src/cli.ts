import { readFile } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "./config/loader.js";
import { SandboxViolationError } from "./sandbox/confinement.js";
import { orchestratorRequestSchema, toOrchestratorRequest } from "./orchestrator/request.js";
import { createSandy, type Sandy, type SandyCheckReport } from "./sandy.js";
import type { OrchestratorResult, ProgressEvent } from "./orchestrator/orchestrator.js";

export const CLI_NAME = "sandy";

/**
 * Exit codes — stable contract for callers/CI:
 *   0  ok (boundary intact; a *degraded* state is reported, not fatal)
 *   1  unexpected error
 *   2  bad usage (unknown verb / flags, or an invalid request file)
 *   3  config error (fail-closed: invalid config, missing env, VPN-02)
 *   4  sandbox violation (unsandboxed or declared/detected runtime mismatch)
 */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  config: 3,
  sandbox: 4,
} as const;

interface ParsedArgs {
  verb?: "check" | "run";
  requestFile?: string;
  configPath?: string;
  auditFile?: string;
  json: boolean;
  progress: boolean;
  help: boolean;
  version: boolean;
  error?: string;
}

function takeValue(flag: string, argv: string[], i: number): { value?: string; next?: number; error?: string } {
  const inline = argv[i]!.includes("=") ? argv[i]!.slice(argv[i]!.indexOf("=") + 1) : undefined;
  if (inline !== undefined) return { value: inline, next: i + 1 };
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("-")) return { error: `option ${flag} requires a value` };
  return { value: next, next: i + 2 };
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false, progress: true, help: false, version: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-V":
      case "--version":
        out.version = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--no-progress":
        out.progress = false;
        break;
      case "-c":
      case "--config": {
        const r = takeValue(a, argv, i);
        if (r.error) return { ...out, error: r.error };
        out.configPath = r.value;
        i = (r.next ?? i + 1) - 1;
        break;
      }
      case "-o":
      case "--audit": {
        const r = takeValue(a, argv, i);
        if (r.error) return { ...out, error: r.error };
        out.auditFile = r.value;
        i = (r.next ?? i + 1) - 1;
        break;
      }
      default:
        if (a.startsWith("-") && a !== "-") return { ...out, error: `unknown option: ${a}` };
        positional.push(a);
    }
  }
  if (positional.length === 0) {
    return { ...out, error: "missing verb (expected `check` or `run`)" };
  }
  const verb = positional[0];
  if (verb !== "check" && verb !== "run") {
    return { ...out, error: `unknown verb: ${verb} (expected '${CLI_NAME} check' or '${CLI_NAME} run')` };
  }
  out.verb = verb;
  if (positional.length > 1) {
    if (verb === "run") out.requestFile = positional[1];
    else return { ...out, error: `unexpected argument: ${positional[1]}` };
  }
  if (verb === "run" && !out.requestFile) {
    return { ...out, error: "`run` requires a request file: sandy run <request.json>" };
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`${CLI_NAME} — SANDBOXable AI assistant (MCP-only, VPN-safe, audit-logged)

usage:
  ${CLI_NAME} check [options]        validate config + print capability/health report
  ${CLI_NAME} run <request.json> [options]   run an orchestrator request (gather → report)

options:
  -c, --config <path>    path to sandy.json (default: $SANDY_CONFIG or ./sandy.json)
  -o, --audit <path>     write the append-only JSONL audit log to <path> (default: in-memory)
      --json             print machine-readable JSON on stdout
      --no-progress      disable streaming progress on stderr
  -h, --help             show this help
  -V, --version          show the version

exit codes:
  0 ok   1 error   2 usage   3 config (fail-closed)   4 sandbox violation
`);
}

function resolveConfigPath(explicit?: string): string {
  return explicit ?? process.env["SANDY_CONFIG"] ?? "sandy.json";
}

function progressSink(enabled: boolean): (e: ProgressEvent) => void {
  if (!enabled) return () => {};
  const w = (s: string) => process.stderr.write(s + "\n");
  return (e) => {
    switch (e.type) {
      case "task-started":
        w(`\u2192 ${e.task}: ${e.server}/${e.tool}`);
        break;
      case "task-succeeded":
        w(`\u2713 ${e.task} (${e.durationMs}ms)`);
        break;
      case "task-failed":
        w(`\u2717 ${e.task}: ${e.error}`);
        break;
      case "report-writing":
        w(`\u270e writing report \u2192 ${e.path}`);
        break;
      case "done":
        w(`\u2022 done: ${e.claims} claim(s), ${e.gaps} gap(s)`);
        break;
    }
  };
}

function formatCheckText(r: SandyCheckReport, auditFile?: string): string {
  const lines: string[] = [];
  lines.push("Sandy check");
  lines.push(`  mode:        ${r.config.mode}`);
  lines.push(`  config:      ${r.config.configDir}`);
  lines.push(`  sandbox:     ${r.sandbox.runtime} (declared: ${r.sandbox.declaredRuntime})`);
  if (r.sandbox.evidence.length > 0) lines.push(`  evidence:    ${r.sandbox.evidence.join("; ")}`);
  lines.push(`  roots:       ${r.sandbox.allowedPaths.join(", ")}`);
  lines.push(`  egress:      ${r.sandbox.allowedNetwork.length > 0 ? r.sandbox.allowedNetwork.join(", ") : "(none declared)"}`);
  lines.push(`  capability:  ${r.sandbox.summary}`);
  if (r.sandbox.lost.length > 0) {
    for (const loss of r.sandbox.lost) lines.push(`    \u2212 ${loss}`);
  }
  lines.push("  MCP servers:");
  const health = r.mcp.health;
  for (const name of health.connected) lines.push(`    \u2713 ${name} \u2014 connected`);
  for (const d of health.degraded) lines.push(`    \u25d0 ${d.server} \u2014 ${d.detail}`);
  for (const u of health.unreachable) lines.push(`    \u25d0 ${u.server} \u2014 ${u.detail}`);
  for (const f of r.mcp.failed) lines.push(`    \u2717 ${f.server} \u2014 startup failure (terminal): ${f.error}`);
  if (
    health.connected.length +
      health.degraded.length +
      health.unreachable.length +
      r.mcp.failed.length ===
    0
  )
    lines.push("    (no MCP servers)");
  lines.push(`  audit:       ${auditFile ?? "in-memory (use --audit <path> to persist)"}`);
  lines.push("");
  lines.push(`  RESULT: ${r.ok ? "OK" : "DEGRADED"}`);
  return lines.join("\n");
}

function formatRunText(r: OrchestratorResult, auditFile?: string): string {
  const lines: string[] = [];
  lines.push("Sandy run");
  lines.push(`  goal:    ${r.goal}`);
  lines.push(`  claims (${r.claims.length}):`);
  if (r.claims.length === 0) lines.push("    (none)");
  for (const c of r.claims) {
    const src = `task=${c.source.task}, ${c.source.server}/${c.source.tool}`;
    lines.push(`    ${c.ref}. ${c.text}  [${src}]`);
  }
  lines.push(`  gaps (${r.gaps.length}):`);
  if (r.gaps.length === 0) lines.push("    (none)");
  for (const g of r.gaps) {
    lines.push(`    \u2212 ${g.task} (${g.server}/${g.tool}): ${g.reason} \u2014 ${g.detail}`);
  }
  if (r.reportPath) lines.push(`  report:  ${r.reportPath}`);
  lines.push(`  audit:   ${auditFile ?? "in-memory"}`);
  return lines.join("\n");
}

async function loadRequest(file: string): Promise<ReturnType<typeof toOrchestratorRequest>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read request file ${file}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`request file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = orchestratorRequestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((iss) => `  - ${iss.path.join(".") || "(root)"}: ${iss.message}`)
      .join("\n");
    throw new UsageError(`invalid orchestrator request in ${file}:\n${issues}`);
  }
  return toOrchestratorRequest(parsed.data);
}

class UsageError extends Error {}
class RunError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

async function withSandy<T>(
  args: ParsedArgs,
  fn: (sandy: Sandy) => T | Promise<T>,
): Promise<T> {
  const sandyPath = resolveConfigPath(args.configPath);
  const sink = progressSink(args.progress);
  const sandy = await createSandy({
    sandyPath,
    auditFile: args.auditFile,
    onProgress: sink,
  });
  try {
    return await fn(sandy);
  } finally {
    await sandy.close();
  }
}

function translateError(err: unknown): RunError {
  if (err instanceof UsageError) return new RunError(EXIT.usage, err.message);
  if (err instanceof ConfigError) return new RunError(EXIT.config, err.message);
  if (err instanceof SandboxViolationError) return new RunError(EXIT.sandbox, err.message);
  return new RunError(EXIT.error, err instanceof Error ? (err.stack ?? err.message) : String(err));
}

/**
 * The CLI entry point. Parses args, dispatches the verb, and returns an exit
 * code. All output goes to stdout (result) / stderr (progress + errors), so
 * `--json` output is clean for piping.
 */
export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return EXIT.ok;
  }
  if (args.version) {
    process.stdout.write(`${CLI_NAME} (sandy) — MCP-only, VPN-safe, audit-logged\n`);
    return EXIT.ok;
  }
  if (args.error) {
    process.stderr.write(`error: ${args.error}\n\nRun '${CLI_NAME} --help' for usage.\n`);
    return EXIT.usage;
  }

  try {
    if (args.verb === "check") {
      const report = await withSandy(args, (s) => s.check());
      if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(formatCheckText(report, args.auditFile) + "\n");
      return EXIT.ok;
    }
    // verb === "run"
    const request = await loadRequest(args.requestFile!);
    const result = await withSandy(args, (s) => s.run(request));
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(formatRunText(result, args.auditFile) + "\n");
    return EXIT.ok;
  } catch (err) {
    const runErr = translateError(err);
    process.stderr.write(`error: ${runErr.message}\n`);
    return runErr.code;
  }
}

// Allow `node dist/cli.js check` directly (in addition to the bin shim).
// Guarded so importing this module (tests, the bin) never auto-runs.
const entry = process.argv[1];
const isDirectRun =
  !!entry && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
if (isDirectRun) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
