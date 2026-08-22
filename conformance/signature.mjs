// The runtime-agnostic behavioral signature for the sandbox conformance matrix
// (SB-10).
//
// The claim under test: the enforcer is runtime-agnostic — given the same
// config and request, `sandy check`/`run` behave *identically* whether the
// boundary is Docker or Firejail. "Behave identically" is asserted on the
// stable behavioral projection below, NOT on a raw byte diff, because a raw
// diff is legitimately non-stable across runtimes (wall-clock timestamps,
// durations, the detected runtime name, its evidence, and absolute workspace
// paths all differ by construction and are not the behavior under test).
//
// What the signature KEEPS (must be identical across runtimes):
//   - the capability decision: ok / degraded / lost / summary
//   - the declared egress allowlist (allowed_network)
//   - the MCP fleet outcome: which servers connected / failed
//   - the provenance: each claim's text, server, tool and its argsHash
//     (argsHash = sha256 of the canonicalized args — the deterministic,
//     runtime-independent provenance token), plus each gap's reason.
//
// What it DROPS (runtime-specific, not the behavior under test):
//   - config.* (absolute workspace paths), sandbox.runtime / declaredRuntime /
//     evidence / allowedPaths, claim timestamps (`at`), the report path and
//     rendered body (timestamps + absolute paths), and the full audit
//     transcript (timestamps, durations, sequence, paths).
//
// Usage: node conformance/signature.mjs <check.json> <run.json>
// Emits the normalized signature as stable (sorted-key) JSON on stdout.
import { readFile } from "node:fs/promises";

function parse(argv) {
  if (argv.length < 2) {
    process.stderr.write("usage: signature.mjs <check.json> <run.json>\n");
    process.exit(2);
  }
  return argv;
}

const [checkFile, runFile] = parse(process.argv.slice(2));

const check = JSON.parse(await readFile(checkFile, "utf8"));
const run = JSON.parse(await readFile(runFile, "utf8"));

// Engine health: stable across boundaries (a ready stub/local model reports
// the same status/model), and the key standalone-mode fact — the in-sandbox
// loopback model came up. (The bound `port` is ephemeral, so it's excluded.)
const engine = check.engine ?? {};
const signature = {
  check: {
    ok: check.ok,
    degraded: check.sandbox.degraded,
    lost: [...check.sandbox.lost].sort(),
    summary: check.sandbox.summary,
    allowedNetwork: [...(check.sandbox.allowedNetwork ?? check.sandbox.allowed_network ?? [])].sort(),
    mcpConnected: [...check.mcp.connected].sort(),
    mcpFailed: check.mcp.failed.map((f) => f.server).sort(),
    engineStatus: engine.status ?? "absent",
    engineModel: engine.model ?? null,
  },
  run: {
    goal: run.goal,
    // `sandy ask` (standalone) returns a LoopResult (with a `plan`); `sandy run`
    // returns an OrchestratorResult. The provenance fields are common to both.
    ...(run.plan ? { planSource: run.plan.source } : {}),
    claimCount: run.claims.length,
    gapCount: run.gaps.length,
    claims: run.claims.map((c) => ({
      text: c.text,
      server: c.source.server,
      tool: c.source.tool,
      argsHash: c.source.argsHash,
    })),
    gaps: run.gaps.map((g) => ({
      reason: g.reason,
      server: g.server,
      tool: g.tool,
    })),
  },
};

// Stable serialization: recursively sort object keys so an identical signature
// always serializes byte-for-byte identically, regardless of insertion order.
function stable(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
  return out;
}

process.stdout.write(`${JSON.stringify(stable(signature), null, 2)}\n`);
