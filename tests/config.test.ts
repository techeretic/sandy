import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadSandyConfig } from "../src/index.js";

const env = { CRM_API_KEY: "from-env", JIRA_TOKEN: "from-env" };

const validMain = {
  mode: "plugin",
  llm: { provider: "host" },
  sandbox: {
    runtime: "docker",
    allowed_paths: ["/home/user/sandy-workspace"],
    allowed_network: ["jira.internal:8443"],
    max_memory_mb: 2048,
    max_cpu_percent: 50,
  },
  mcp_servers: "./mcp-servers.json",
  report_output_dir: "./reports",
  policy: {
    confirmation_required: ["delete", "overwrite"],
    undo_depth: 10,
    dry_run_default: false,
    audit_payload_logging: false,
    ignore_patterns: ["node_modules/"],
  },
  preferences: {
    default_report_format: "markdown",
    max_concurrent_mcp_calls: 5,
    stream_progress: true,
  },
};

const validManifest = {
  servers: [
    {
      name: "crm",
      transport: "stdio",
      command: ["npx", "-y", "@company/crm-mcp-server"],
      env: { CRM_API_KEY: "${CRM_API_KEY}" },
      version: "1.4.2",
      capabilities: ["read_deals", "read_contacts"],
      allowed_tools: ["read_deals", "read_contacts"],
    },
    {
      name: "jira",
      transport: "sse",
      url: "https://jira.internal:8443/mcp",
      auth: { type: "bearer", token: "${JIRA_TOKEN}" },
      version: "0.9.1",
      capabilities: ["read_sprints", "read_issues"],
      allowed_tools: ["read_sprints"],
    },
  ],
};

async function makeFixture(
  main: object,
  manifest: object,
): Promise<{ dir: string; sandyPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "sandy-"));
  const sandyPath = path.join(dir, "sandy.json");
  await writeFile(sandyPath, JSON.stringify(main, null, 2));
  await writeFile(path.join(dir, "mcp-servers.json"), JSON.stringify(manifest, null, 2));
  return { dir, sandyPath };
}

describe("loadSandyConfig", () => {
  it("loads a valid config and manifest", async () => {
    const { dir, sandyPath } = await makeFixture(validMain, validManifest);
    try {
      const loaded = await loadSandyConfig(sandyPath, env);
      expect(loaded.config.mode).toBe("plugin");
      expect(loaded.manifest.servers).toHaveLength(2);
      expect(loaded.reportOutputDir).toBe(path.join(dir, "reports"));
      expect(loaded.resolveSecret("${JIRA_TOKEN}")).toBe("from-env");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps secret refs in the parsed config (no literal values)", async () => {
    const { dir, sandyPath } = await makeFixture(validMain, validManifest);
    try {
      const loaded = await loadSandyConfig(sandyPath, env);
      const raw = JSON.stringify(loaded.config) + JSON.stringify(loaded.manifest);
      expect(raw).not.toContain("from-env");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects literal secret values in auth", async () => {
    const manifest = {
      ...validManifest,
      servers: [
        {
          ...validManifest.servers[1],
          auth: { type: "bearer", token: "hunter2" },
        },
      ],
    };
    const { dir, sandyPath } = await makeFixture(validMain, manifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toMatch(/environment variable/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a referenced env var is missing", async () => {
    const { dir, sandyPath } = await makeFixture(validMain, validManifest);
    try {
      const result = await loadSandyConfig(sandyPath, { CRM_API_KEY: "x" }).catch(
        (e) => e,
      );
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("JIRA_TOKEN");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown top-level fields (strict)", async () => {
    const main = { ...validMain, surprise: true };
    const { dir, sandyPath } = await makeFixture(main, validManifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("surprise");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects paths containing '..' traversal", async () => {
    const main = {
      ...validMain,
      sandbox: { ...validMain.sandbox, allowed_paths: ["/home/user/../etc"] },
    };
    const { dir, sandyPath } = await makeFixture(main, validManifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toMatch(/\.\./);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an allowed_tools entry not in capabilities (MCP-07)", async () => {
    const manifest = {
      ...validManifest,
      servers: [
        {
          ...validManifest.servers[0],
          allowed_tools: ["read_deals", "delete_all_data"],
        },
      ],
    };
    const { dir, sandyPath } = await makeFixture(validMain, manifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("delete_all_data");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate server names", async () => {
    const manifest = {
      servers: [validManifest.servers[0], { ...validManifest.servers[0] }],
    };
    const { dir, sandyPath } = await makeFixture(validMain, manifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toMatch(/unique/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-exact version pins (Q7)", async () => {
    const manifest = {
      ...validManifest,
      servers: [{ ...validManifest.servers[0], version: "^1.0.0" }],
    };
    const { dir, sandyPath } = await makeFixture(validMain, manifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toMatch(/semver pin/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces VPN-02: remote MCP endpoints must be in allowed_network", async () => {
    const manifest = {
      ...validManifest,
      servers: [
        {
          ...validManifest.servers[1],
          url: "https://evil.example.com:8443/mcp",
        },
      ],
    };
    const { dir, sandyPath } = await makeFixture(validMain, manifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("VPN-02");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows an MCP server URL at the scheme's explicit default port when allowed_network declares that port", async () => {
    const main = {
      ...validMain,
      sandbox: { ...validMain.sandbox, allowed_network: ["internal.company.com:443"] },
    };
    const manifest = {
      ...validManifest,
      servers: [
        {
          name: "docs",
          transport: "http",
          url: "https://internal.company.com:443/mcp",
          version: "1.0.0",
          capabilities: ["read"],
          allowed_tools: ["read"],
        },
      ],
    };
    const { dir, sandyPath } = await makeFixture(main, manifest);
    try {
      const loaded = await loadSandyConfig(sandyPath, env);
      expect(loaded.manifest.servers).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces VPN-02 for a default-port URL when allowed_network omits the port", async () => {
    const main = {
      ...validMain,
      sandbox: { ...validMain.sandbox, allowed_network: ["internal.company.com"] },
    };
    const manifest = {
      ...validManifest,
      servers: [
        {
          name: "docs",
          transport: "http",
          url: "https://internal.company.com/mcp",
          version: "1.0.0",
          capabilities: ["read"],
          allowed_tools: ["read"],
        },
      ],
    };
    const { dir, sandyPath } = await makeFixture(main, manifest);
    try {
      const loaded = await loadSandyConfig(sandyPath, env);
      expect(loaded.manifest.servers).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a policy that drops delete confirmation (FM-04)", async () => {
    const main = {
      ...validMain,
      policy: { ...validMain.policy, confirmation_required: ["overwrite"] },
    };
    const { dir, sandyPath } = await makeFixture(main, validManifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("delete");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sandy-"));
    const sandyPath = path.join(dir, "sandy.json");
    await writeFile(sandyPath, "{ not json");
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("not valid JSON");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on a missing manifest file", async () => {
    const { dir, sandyPath } = await makeFixture(validMain, validManifest);
    await rm(path.join(dir, "mcp-servers.json"));
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("mcp-servers.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
