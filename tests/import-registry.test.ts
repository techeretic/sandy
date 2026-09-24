import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  convertRegistryServerJson,
  isRegistryServerJson,
  registryServerName,
} from "../src/import-registry.js";
import { parseAndValidateManifest, runImport } from "../src/import.js";

// Modeled on the Library of Congress server's real server.json (trimmed).
const locServerJson = {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.github.cyanheads/libofcongress-mcp-server",
  version: "0.3.0",
  remotes: [{ type: "streamable-http", url: "https://libofcongress.caseyjhand.com/mcp" }],
  packages: [
    {
      registryType: "npm",
      identifier: "@cyanheads/libofcongress-mcp-server",
      runtimeHint: "bun",
      version: "0.3.0",
      packageArguments: [
        { type: "positional", value: "run" },
        { type: "positional", value: "start:stdio" },
      ],
      environmentVariables: [{ name: "LOC_USER_AGENT", isRequired: false, default: "x" }],
      transport: { type: "stdio" },
    },
  ],
};
const TOOLS = { "libofcongress-mcp-server": ["libofcongress_search", "libofcongress_get_item"] };

describe("MCP Registry server.json conversion", () => {
  it("recognizes a registry entry, never a native manifest", () => {
    expect(isRegistryServerJson(locServerJson)).toBe(true);
    expect(isRegistryServerJson({ servers: [], name: "x", packages: [] })).toBe(false);
    expect(isRegistryServerJson({ name: "x" })).toBe(false);
    expect(isRegistryServerJson([])).toBe(false);
  });

  it("derives a kebab-case server name from the registry name", () => {
    expect(registryServerName("io.github.cyanheads/libofcongress-mcp-server")).toBe("libofcongress-mcp-server");
    expect(registryServerName("com.example/My_Server.v2")).toBe("my-server-v2");
    expect(() => registryServerName("io.github.x/123")).toThrow(/cannot derive/);
  });

  it("requires the operator to declare the tools (the registry format lists none)", () => {
    expect(() => convertRegistryServerJson(locServerJson, undefined, "package")).toThrow(
      /--tools libofcongress-mcp-server=/,
    );
  });

  it("refuses to choose between a remote and a package on its own", () => {
    expect(() => convertRegistryServerJson(locServerJson, TOOLS, undefined)).toThrow(/--registry-source remote.*--registry-source package/);
  });

  it("converts the package to a pinned stdio entry", () => {
    const m = convertRegistryServerJson(locServerJson, TOOLS, "package");
    expect(m.servers[0]).toEqual({
      name: "libofcongress-mcp-server",
      transport: "stdio",
      command: ["npx", "-y", "@cyanheads/libofcongress-mcp-server@0.3.0", "run", "start:stdio"],
      version: "0.3.0",
      capabilities: TOOLS["libofcongress-mcp-server"],
      allowed_tools: TOOLS["libofcongress-mcp-server"],
    });
  });

  it("converts the remote to an http entry", () => {
    const m = convertRegistryServerJson(locServerJson, TOOLS, "remote");
    expect(m.servers[0]).toMatchObject({
      name: "libofcongress-mcp-server",
      transport: "http",
      url: "https://libofcongress.caseyjhand.com/mcp",
      version: "0.3.0",
    });
  });

  it("uses the only source present without asking", () => {
    const remoteOnly = { ...locServerJson, packages: undefined };
    expect(convertRegistryServerJson(remoteOnly, TOOLS, undefined).servers[0]).toMatchObject({ transport: "http" });
  });

  it("maps required env vars to env refs and named args to flag/value pairs; pypi uses uvx", () => {
    const py = {
      name: "com.example/weather",
      version: "1.2.3",
      packages: [
        {
          registryType: "pypi",
          identifier: "weather-mcp",
          version: "1.2.3",
          packageArguments: [{ type: "named", name: "--units", value: "metric" }],
          environmentVariables: [
            { name: "WEATHER_KEY", isRequired: true, isSecret: true },
            { name: "OPTIONAL_ONE", isRequired: false },
          ],
        },
      ],
    };
    const m = convertRegistryServerJson(py, { weather: ["forecast"] }, undefined);
    expect(m.servers[0]).toMatchObject({
      command: ["uvx", "weather-mcp==1.2.3", "--units", "metric"],
      env: { WEATHER_KEY: "${WEATHER_KEY}" },
    });
  });

  it("refuses what it cannot map without guessing", () => {
    const headers = { ...locServerJson, packages: undefined, remotes: [{ type: "sse", url: "https://x.example/sse", headers: [{ name: "Authorization" }] }] };
    expect(() => convertRegistryServerJson(headers, TOOLS, undefined)).toThrow(/headers/);
    const templated = { ...locServerJson, packages: undefined, remotes: [{ type: "sse", url: "https://{tenant}.example/sse" }] };
    expect(() => convertRegistryServerJson(templated, TOOLS, undefined)).toThrow(/templated/);
    const oci = { ...locServerJson, remotes: undefined, packages: [{ registryType: "oci", identifier: "x", version: "1.0.0" }] };
    expect(() => convertRegistryServerJson(oci, TOOLS, undefined)).toThrow(/supported registry/);
    const needsArg = {
      ...locServerJson,
      remotes: undefined,
      packages: [{ ...locServerJson.packages[0], packageArguments: [{ type: "positional", isRequired: true }] }],
    };
    expect(() => convertRegistryServerJson(needsArg, TOOLS, undefined)).toThrow(/no fixed value/);
  });

  it("the converted candidate still passes through the native schema (exact-semver pin)", () => {
    const unpinned = { ...locServerJson, remotes: undefined, packages: [{ ...locServerJson.packages[0], version: "latest" }] };
    expect(() =>
      parseAndValidateManifest(JSON.stringify(unpinned), "test", { tools: TOOLS }),
    ).toThrowError(/version/);
  });

  it("stages a registry server.json, pinned to the hash of the original bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sandy-import-registry-"));
    try {
      const src = path.join(root, "server.json");
      const text = JSON.stringify(locServerJson);
      await writeFile(src, text, "utf8");
      const result = await runImport(
        { file: src },
        { stageDir: path.join(root, "staged"), tools: TOOLS, registrySource: "package" },
      );
      expect(result.format).toBe("mcp-registry");
      expect(result.review.servers[0]).toMatchObject({ name: "libofcongress-mcp-server", transport: "stdio" });
      const staged = JSON.parse(await readFile(result.staged, "utf8"));
      expect(staged.manifest.servers[0].command[2]).toBe("@cyanheads/libofcongress-mcp-server@0.3.0");
      const { createHash } = await import("node:crypto");
      expect(result.hash).toBe(createHash("sha256").update(text).digest("hex"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a native manifest reports format native", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sandy-import-native-"));
    try {
      const src = path.join(root, "m.json");
      await writeFile(
        src,
        JSON.stringify({
          servers: [{ name: "crm", transport: "stdio", command: ["x"], version: "1.0.0", capabilities: ["a"], allowed_tools: ["a"] }],
        }),
        "utf8",
      );
      const result = await runImport({ file: src }, { stageDir: path.join(root, "staged") });
      expect(result.format).toBe("native");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
