import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  NetworkEgressError,
  NetworkGuard,
  createSandy,
  createTransport,
  guardedFetch,
  InMemoryAuditLogger,
  McpClientManager,
  SecretResolver,
  type AuditEvent,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const epServer = path.join(here, "ep-server.mjs");

interface Endpoint {
  url: string;
  hostport: string;
  kill: () => void;
}

async function startEndpoint(): Promise<Endpoint> {
  const child = spawn(process.execPath, [epServer], { stdio: ["ignore", "pipe", "inherit"] });
  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("endpoint did not report its URL in time")), 5000);
    child.stdout!.on("data", (d) => {
      buf += d.toString();
      const line = buf.trim();
      if (line.startsWith("http://")) {
        clearTimeout(timer);
        resolve(line);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`endpoint exited early (code ${code})`));
    });
  });
  return { url, hostport: new URL(url).host, kill: () => child.kill("SIGKILL") };
}

let root: string;
const tmpDirs: string[] = [];
let ep: Endpoint;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sandy-egress-"));
  tmpDirs.push(root);
  ep = await startEndpoint();
});

afterAll(async () => {
  ep.kill();
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function crmServer(url: string): { name: string; transport: "http"; url: string; version: string; capabilities: string[]; allowed_tools: string[] } {
  return { name: "crm", transport: "http", url, version: "1.0.0", capabilities: ["read_deals"], allowed_tools: ["read_deals"] };
}

async function writeConfig(dir: string, opts: { allowedPaths: string[]; url: string; hostport: string }): Promise<string> {
  const manifest = { servers: [crmServer(opts.url)] };
  const main = {
    mode: "plugin",
    llm: { provider: "host" },
    sandbox: {
      runtime: "custom",
      allowed_paths: opts.allowedPaths,
      allowed_network: [opts.hostport],
      max_memory_mb: 512,
      max_cpu_percent: 25,
    },
    mcp_servers: "./mcp-servers.json",
    report_output_dir: "./reports",
    policy: {
      confirmation_required: ["delete", "overwrite"],
      undo_depth: 5,
      dry_run_default: false,
      audit_payload_logging: false,
      ignore_patterns: [],
    },
  };
  await writeFile(path.join(dir, "mcp-servers.json"), JSON.stringify(manifest, null, 2));
  const cfgPath = path.join(dir, "sandy.json");
  await writeFile(cfgPath, JSON.stringify(main, null, 2));
  return cfgPath;
}

/** A fetch that records every URL it is asked to dial, then forwards to real fetch. */
function recordingFetch() {
  const hit: string[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    hit.push(typeof url === "string" ? url : url.toString());
    return globalThis.fetch(url, init);
  }) as typeof fetch;
  return { hit, fn };
}

async function ws(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "sandy-egress-ws-"));
  tmpDirs.push(d);
  return d;
}

describe("egress conformance (in-process): the NetworkGuard is the only egress path", () => {
  it("the only endpoint ever dialed is the declared one; a real run succeeds", async () => {
    const dir = await ws();
    const guard = new NetworkGuard([ep.hostport]);
    const resolver = new SecretResolver({});
    const audit = new InMemoryAuditLogger();
    const { hit, fn } = recordingFetch();

    const manager = new McpClientManager([crmServer(ep.url)], resolver, guard, {
      audit: { record: (r) => audit.append("mcp_call", r as never) },
      transportFactory: (server) => createTransport(server, resolver, guard, fn),
    });
    const connect = await manager.connectAll();
    expect(connect.failed).toEqual([]);

    const result = await manager.callTool("crm", "read_deals", { region: "emea" });
    const texts = (result as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(texts.join(" ")).toContain("2 deals closed in emea");

    // The egress contract: every URL dialed must be the declared endpoint.
    expect(hit.length).toBeGreaterThan(0);
    for (const u of hit) {
      expect(new URL(u).host).toBe(ep.hostport);
    }
    await manager.close();
  });

  it("an undeclared endpoint is refused by the guard and the dial never happens (VPN-02)", async () => {
    const { hit, fn } = recordingFetch();
    const guard = new NetworkGuard([ep.hostport]);
    const fetchWithGuard = guardedFetch(guard, fn);

    await expect(fetchWithGuard(`http://attacker.example.com/steal`)).rejects.toThrow(NetworkEgressError);
    // Nothing was dialed — the guard refused before the inner fetch.
    expect(hit).toEqual([]);
  });

  it("an egress block is recorded in the audit log (egress_blocked, AU-01)", async () => {
    const { fn } = recordingFetch();
    const guard = new NetworkGuard([ep.hostport]);
    const audit = new InMemoryAuditLogger();
    const fetchWithGuard = guardedFetch(guard, fn, audit);

    await expect(fetchWithGuard("http://evil.example:9999/x")).rejects.toThrow(NetworkEgressError);
    const blocked = audit.events().filter((e: AuditEvent) => e.type === "egress_blocked");
    expect(blocked).toHaveLength(1);
    expect((blocked[0]!.data as { reason: string }).reason).toBe("endpoint-not-declared");
  });

  it("a full createSandy run routes all egress through the guard to the one declared endpoint", async () => {
    const dir = await ws();
    const cfg = await writeConfig(dir, { allowedPaths: [dir], url: ep.url, hostport: ep.hostport });
    const { hit, fn } = recordingFetch();

    const sandy = await createSandy({
      sandyPath: cfg,
      auditFile: path.join(dir, "audit", "egress.jsonl"),
      transportFactory: (server) => createTransport(server, new SecretResolver({}), new NetworkGuard([ep.hostport]), fn),
    });
    try {
      const report = sandy.check();
      expect(report.ok).toBe(true);
      const result = await sandy.run({
        goal: "deals",
        gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
      });
      expect(result.claims).toHaveLength(1);
      expect(result.gaps).toEqual([]);
      for (const u of hit) {
        expect(new URL(u).host).toBe(ep.hostport);
      }
    } finally {
      await sandy.close();
    }
  });

  it("the loader fails closed on a remote endpoint not in allowed_network (VPN-02, config-time)", async () => {
    const dir = await ws();
    const manifest = {
      servers: [
        {
          name: "crm",
          transport: "http",
          url: "http://undeclared.example:8443/mcp",
          version: "1.0.0",
          capabilities: ["read_deals"],
          allowed_tools: ["read_deals"],
        },
      ],
    };
    const main = {
      mode: "plugin",
      llm: { provider: "host" },
      sandbox: {
        runtime: "custom",
        allowed_paths: [dir],
        allowed_network: [ep.hostport],
        max_memory_mb: 512,
        max_cpu_percent: 25,
      },
      mcp_servers: "./mcp-servers.json",
      report_output_dir: "./reports",
      policy: {
        confirmation_required: ["delete", "overwrite"],
        undo_depth: 5,
        dry_run_default: false,
        audit_payload_logging: false,
        ignore_patterns: [],
      },
    };
    await writeFile(path.join(dir, "mcp-servers.json"), JSON.stringify(manifest, null, 2));
    const cfg = path.join(dir, "sandy.json");
    await writeFile(cfg, JSON.stringify(main, null, 2));

    await expect(createSandy({ sandyPath: cfg })).rejects.toThrow(ConfigError);
  });
});
