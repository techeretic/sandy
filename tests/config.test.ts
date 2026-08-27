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
  templates?: object,
): Promise<{ dir: string; sandyPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "sandy-"));
  const sandyPath = path.join(dir, "sandy.json");
  await writeFile(sandyPath, JSON.stringify(main, null, 2));
  await writeFile(path.join(dir, "mcp-servers.json"), JSON.stringify(manifest, null, 2));
  if (templates !== undefined) {
    await writeFile(path.join(dir, "templates.json"), JSON.stringify(templates, null, 2));
  }
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

  it("sandbox.enforce_memory_limit defaults to false and accepts true (issue #18)", async () => {
    const { dir, sandyPath } = await makeFixture(validMain, validManifest);
    try {
      const loaded = await loadSandyConfig(sandyPath, env);
      expect(loaded.config.sandbox.enforce_memory_limit).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const main = {
      ...validMain,
      sandbox: { ...validMain.sandbox, enforce_memory_limit: true },
    };
    const fixture = await makeFixture(main, validManifest);
    try {
      const loaded = await loadSandyConfig(fixture.sandyPath, env);
      expect(loaded.config.sandbox.enforce_memory_limit).toBe(true);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("fails closed on a non-boolean sandbox.enforce_memory_limit (strict, issue #18)", async () => {
    const main = {
      ...validMain,
      sandbox: { ...validMain.sandbox, enforce_memory_limit: "yes" },
    };
    const { dir, sandyPath } = await makeFixture(main, validManifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("narrowed reportFormat: markdown is the default, html is accepted (issue #14)", async () => {
    const { dir, sandyPath } = await makeFixture(validMain, validManifest);
    try {
      const loaded = await loadSandyConfig(sandyPath, env);
      expect(loaded.reportFormat).toBe("markdown");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const main = {
      ...validMain,
      preferences: { ...validMain.preferences, default_report_format: "html" },
    };
    const fixture = await makeFixture(main, validManifest);
    try {
      const loaded = await loadSandyConfig(fixture.sandyPath, env);
      expect(loaded.reportFormat).toBe("html");
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("preferences.max_planning_rounds defaults to 1 (single pass) and accepts a small int (issue #19)", async () => {
    const { dir, sandyPath } = await makeFixture(validMain, validManifest);
    try {
      const loaded = await loadSandyConfig(sandyPath, env);
      expect(loaded.config.preferences?.max_planning_rounds).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const main = {
      ...validMain,
      preferences: { ...validMain.preferences, max_planning_rounds: 3 },
    };
    const fixture = await makeFixture(main, validManifest);
    try {
      const loaded = await loadSandyConfig(fixture.sandyPath, env);
      expect(loaded.config.preferences?.max_planning_rounds).toBe(3);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("fails closed on an out-of-range preferences.max_planning_rounds (issue #19)", async () => {
    for (const rounds of [0, 6, 1.5]) {
      const main = {
        ...validMain,
        preferences: { ...validMain.preferences, max_planning_rounds: rounds },
      };
      const { dir, sandyPath } = await makeFixture(main, validManifest);
      try {
        const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
        expect(result).toBeInstanceOf(ConfigError);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("fails closed on an unimplemented default_report_format (docx/xlsx/pdf, issue #14)", async () => {
    for (const format of ["docx", "xlsx", "pdf"]) {
      const main = {
        ...validMain,
        preferences: { ...validMain.preferences, default_report_format: format },
      };
      const { dir, sandyPath } = await makeFixture(main, validManifest);
      try {
        const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
        expect(result).toBeInstanceOf(ConfigError);
        expect((result as Error).message).toContain(format);
        expect((result as Error).message).toMatch(/not supported yet/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
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

// --- template registry (issue #15 / RG-08) -----------------------------------

describe("loadSandyConfig: template registry (issue #15)", () => {
  const validTemplates = {
    "deals-emea": {
      goal: "EMEA deals",
      gather: [{ id: "deals", server: "crm", tool: "read_deals", args: { region: "emea" } }],
      report: { title: "EMEA Deals", file: "deals-emea.md" },
    },
  };

  it("no templates.path → loaded.templates is undefined", async () => {
    const { dir, sandyPath } = await makeFixture(validMain, validManifest);
    try {
      const loaded = await loadSandyConfig(sandyPath, env);
      expect(loaded.templates).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a valid templates.path registry (relative to the config dir)", async () => {
    const main = { ...validMain, templates: { path: "./templates.json" } };
    const { dir, sandyPath } = await makeFixture(main, validManifest, validTemplates);
    try {
      const loaded = await loadSandyConfig(sandyPath, env);
      expect(loaded.templates).toEqual(validTemplates);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the templates file is missing", async () => {
    const main = { ...validMain, templates: { path: "./templates.json" } };
    const { dir, sandyPath } = await makeFixture(main, validManifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("templates.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the templates file is not valid JSON", async () => {
    const main = { ...validMain, templates: { path: "./templates.json" } };
    const dir = await mkdtemp(path.join(tmpdir(), "sandy-"));
    const sandyPath = path.join(dir, "sandy.json");
    await writeFile(sandyPath, JSON.stringify(main, null, 2));
    await writeFile(path.join(dir, "mcp-servers.json"), JSON.stringify(validManifest, null, 2));
    await writeFile(path.join(dir, "templates.json"), "{ not json");
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toMatch(/not valid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a template entry is not a legal request (schema)", async () => {
    const main = { ...validMain, templates: { path: "./templates.json" } };
    const { dir, sandyPath } = await makeFixture(
      main,
      validManifest,
      { broken: { goal: "x", gather: [] } },
    );
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("gather");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a template name is not kebab-case", async () => {
    const main = { ...validMain, templates: { path: "./templates.json" } };
    const { dir, sandyPath } = await makeFixture(
      main,
      validManifest,
      { "Bad Name": { goal: "x", gather: [{ id: "a", server: "crm", tool: "read_deals" }] } },
    );
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toMatch(/kebab-case/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a template references an unknown server", async () => {
    const main = { ...validMain, templates: { path: "./templates.json" } };
    const { dir, sandyPath } = await makeFixture(
      main,
      validManifest,
      {
        rogue: {
          goal: "x",
          gather: [{ id: "h", server: "hr", tool: "read_pii" }],
        },
      },
    );
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("unknown server");
      expect((result as Error).message).toContain("hr");
      expect((result as Error).message).toMatch(/fail-closed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a template references a tool not in allowed_tools", async () => {
    const main = { ...validMain, templates: { path: "./templates.json" } };
    const { dir, sandyPath } = await makeFixture(
      main,
      validManifest,
      {
        rogue: {
          goal: "x",
          gather: [{ id: "d", server: "crm", tool: "delete_all" }],
        },
      },
    );
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("delete_all");
      expect((result as Error).message).toMatch(/not allowed on server/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadSandyConfig: write allowlist (issue #16 / Q6)", () => {
  it("no write_allowlist → loaded.writeAllowlist is undefined (read-only default)", async () => {
    const { dir, sandyPath } = await makeFixture(validMain, validManifest);
    try {
      const loaded = await loadSandyConfig(sandyPath, env);
      expect(loaded.writeAllowlist).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a valid write_allowlist (subset of the read allowlist)", async () => {
    const main = {
      ...validMain,
      write_allowlist: [{ server: "crm", tool: "read_contacts" }],
    };
    const { dir, sandyPath } = await makeFixture(main, validManifest);
    try {
      const loaded = await loadSandyConfig(sandyPath, env);
      expect(loaded.writeAllowlist).toEqual([{ server: "crm", tool: "read_contacts" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a write_allowlist entry names an unknown server", async () => {
    const main = {
      ...validMain,
      write_allowlist: [{ server: "erp", tool: "post_invoice" }],
    };
    const { dir, sandyPath } = await makeFixture(main, validManifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("unknown server");
      expect((result as Error).message).toContain("erp");
      expect((result as Error).message).toMatch(/fail-closed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a write_allowlist tool is not in the server's allowed_tools (CP-02)", async () => {
    // crm allows read_deals/read_contacts; write_all is not on the read allowlist.
    const main = {
      ...validMain,
      write_allowlist: [{ server: "crm", tool: "write_all" }],
    };
    const { dir, sandyPath } = await makeFixture(main, validManifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("write_all");
      expect((result as Error).message).toMatch(/subset of the read allowlist/);
      expect((result as Error).message).toMatch(/CP-02/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed write_allowlist entry (strict schema)", async () => {
    const main = {
      ...validMain,
      write_allowlist: [{ server: "crm", tool: "read_deals", extra: true }],
    };
    const { dir, sandyPath } = await makeFixture(main, validManifest);
    try {
      const result = await loadSandyConfig(sandyPath, env).catch((e) => e);
      expect(result).toBeInstanceOf(ConfigError);
      expect((result as Error).message).toContain("write_allowlist");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
