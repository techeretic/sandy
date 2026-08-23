import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SandboxEnforcer,
  SandboxViolationError,
  NetworkEgressError,
  NetworkGuard,
  PathConfinement,
  detectRuntime,
  type McpServersManifest,
  type SandboxConfig,
} from "../src/index.js";

const sandboxConfig = (overrides: Partial<SandboxConfig> = {}): SandboxConfig =>
  ({
    runtime: "docker",
    allowed_paths: ["/home/user/sandy-workspace"],
    allowed_network: ["jira.internal:8443"],
    max_memory_mb: 2048,
    max_cpu_percent: 50,
    ...overrides,
  }) as SandboxConfig;

const mcpManifest: McpServersManifest = {
  servers: [
    {
      name: "crm",
      transport: "stdio",
      command: ["npx", "-y", "@company/crm-mcp-server"],
      version: "1.4.2",
      capabilities: ["read_deals"],
      allowed_tools: ["read_deals"],
    },
  ],
} as unknown as McpServersManifest;

describe("detectRuntime", () => {
  const ctx = (over: Partial<Parameters<typeof detectRuntime>[0]> = {}) => ({
    env: {} as Record<string, string | undefined>,
    fileExists: () => false,
    readFileSync: () => "",
    ...over,
  });

  it("detects firejail via the FIREJAIL env", () => {
    expect(detectRuntime(ctx({ env: { FIREJAIL: "1" } })).runtime).toBe("firejail");
  });

  it("detects firejail via container=firejail (the signal real firejail sets)", () => {
    expect(detectRuntime(ctx({ env: { container: "firejail" } })).runtime).toBe("firejail");
  });

  it("detects firejail via the /.firejail marker", () => {
    expect(detectRuntime(ctx({ fileExists: (p) => p === "/.firejail" })).runtime).toBe("firejail");
  });

  it("prefers firejail over the inherited host docker signals (nested jail)", () => {
    // A firejail jail on a Docker host inherits docker cgroup/mountinfo; the
    // inner boundary must win.
    const env = { container: "firejail" };
    const readFileSync = (p: string) =>
      p === "/proc/1/cgroup"
        ? "0::/docker/abcd1234\n"
        : p === "/proc/self/mountinfo"
          ? "overlay / docker\n"
          : "";
    const fileExists = (p: string) => p === "/.dockerenv";
    expect(detectRuntime(ctx({ env, readFileSync, fileExists })).runtime).toBe("firejail");
  });

  it("does not mistake an unrelated container runtime for firejail", () => {
    expect(detectRuntime(ctx({ env: { container: "lxc" } })).runtime).toBe("none");
  });

  it("detects docker via /.dockerenv", () => {
    expect(detectRuntime(ctx({ fileExists: (p) => p === "/.dockerenv" })).runtime).toBe(
      "docker",
    );
  });

  it("detects k8s pod via container + service env", () => {
    const env = { container: "docker", KUBERNETES_SERVICE_HOST: "10.0.0.1" };
    expect(detectRuntime(ctx({ env, fileExists: (p) => p === "/.dockerenv" })).runtime).toBe(
      "k8s-pod",
    );
  });

  it("detects WSL via osrelease", () => {
    expect(
      detectRuntime(ctx({ readFileSync: (p) => (p === "/proc/sys/kernel/osrelease" ? "5.15.153.1-microsoft-standard-WSL2" : "") }))
        .runtime,
    ).toBe("wsl");
  });

  it("detects none on a plain host", () => {
    expect(detectRuntime(ctx({})).runtime).toBe("none");
  });
});

describe("PathConfinement", () => {
  let workspace: string;
  let outside: string;

  beforeAll(async () => {
    workspace = await realpath(await mkdtemp(path.join(tmpdir(), "sandy-ws-")));
    outside = await realpath(await mkdtemp(path.join(tmpdir(), "sandy-out-")));
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("resolves relative paths against the primary root", async () => {
    const pc = new PathConfinement([workspace]);
    expect(await pc.resolve("reports")).toBe(path.join(workspace, "reports"));
    expect(await pc.resolve("reports/a.md")).toBe(path.join(workspace, "reports", "a.md"));
  });

  it("accepts absolute paths inside the root", async () => {
    const pc = new PathConfinement([workspace]);
    expect(await pc.resolve(path.join(workspace, "x.txt"))).toBe(path.join(workspace, "x.txt"));
  });

  it("allows creating paths whose parents do not exist yet", async () => {
    const pc = new PathConfinement([workspace]);
    const fresh = path.join(workspace, "brand", "new", "dir", "file.md");
    expect(await pc.resolve(fresh)).toBe(fresh);
  });

  it("rejects '..' traversal lexically", async () => {
    const pc = new PathConfinement([workspace]);
    const err = await pc.resolve("a/../../etc/passwd").catch((e) => e);
    expect(err).toBeInstanceOf(SandboxViolationError);
    expect((err as SandboxViolationError).reason).toBe("escape-path");
  });

  it("rejects absolute paths outside the root", async () => {
    const pc = new PathConfinement([workspace]);
    const err = await pc.resolve("/etc/passwd").catch((e) => e);
    expect(err).toBeInstanceOf(SandboxViolationError);
    expect((err as SandboxViolationError).reason).toBe("escape-path");
  });

  it("rejects null bytes", async () => {
    const pc = new PathConfinement([workspace]);
    const err = await pc.resolve("a\0b.txt").catch((e) => e);
    expect(err).toBeInstanceOf(SandboxViolationError);
    expect((err as SandboxViolationError).reason).toBe("null-byte");
  });

  it("rejects a symlink inside the root that points outside (SB-06)", async () => {
    const link = path.join(workspace, "sneaky");
    await symlink(outside, link);
    const pc = new PathConfinement([workspace]);
    const err = await pc.resolve(path.join(link, "secret.txt")).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxViolationError);
    expect((err as SandboxViolationError).reason).toBe("symlink-escape");
    await rm(link);
  });

  it("allows a symlink that stays inside the root", async () => {
    const target = path.join(workspace, "real-dir");
    await mkdir(target, { recursive: true });
    const link = path.join(workspace, "alias");
    await symlink(target, link);
    const pc = new PathConfinement([workspace]);
    expect(await pc.resolve(path.join(link, "f.txt"))).toBe(path.join(target, "f.txt"));
    await rm(link);
    await rm(target, { recursive: true });
  });

  it("fails closed when the working root does not exist", async () => {
    const missing = path.join(tmpdir(), "sandy-does-not-exist");
    const pc = new PathConfinement([missing]);
    const err = await pc.resolve("x.txt").catch((e) => e);
    expect(err).toBeInstanceOf(SandboxViolationError);
    expect((err as SandboxViolationError).reason).toBe("root-missing");
  });

  it("supports multiple roots", async () => {
    const pc = new PathConfinement([workspace, outside]);
    expect(await pc.resolve(outside)).toBe(outside);
    await expect(pc.resolve(path.join(outside, "y.txt"))).resolves.toBe(path.join(outside, "y.txt"));
  });

  it("rejects an empty root list", () => {
    expect(() => new PathConfinement([])).toThrow(SandboxViolationError);
  });
});

describe("NetworkGuard", () => {
  const guard = new NetworkGuard(["jira.internal:8443", "crm.internal"]);

  it("allows a declared endpoint", () => {
    expect(guard.check("https://jira.internal:8443/mcp")).toEqual({ ok: true });
  });

  it("allows a declared endpoint on default port", () => {
    expect(guard.check("https://crm.internal/mcp")).toEqual({ ok: true });
  });

  it("check() matches an endpoint declared without a port against a URL at the scheme's default port", () => {
    const g = new NetworkGuard(["internal.company.com"]);
    expect(g.check("https://internal.company.com/mcp")).toEqual({ ok: true });
    expect(g.check("http://internal.company.com/mcp")).toEqual({ ok: true });
    // A bare-host entry must NOT authorize a non-default port.
    expect(g.check("https://internal.company.com:8443/mcp")).toEqual({
      ok: false,
      reason: "endpoint-not-declared",
    });
  });

  it("check() matches an endpoint declared with an explicit default port against the same URL", () => {
    const g = new NetworkGuard(["internal.company.com:443"]);
    expect(g.check("https://internal.company.com/mcp")).toEqual({ ok: true });
    expect(g.check("https://internal.company.com:443/mcp")).toEqual({ ok: true });
    // A :443 entry must NOT authorize a non-default https port.
    expect(g.check("https://internal.company.com:8443/mcp")).toEqual({
      ok: false,
      reason: "endpoint-not-declared",
    });
  });

  it("check() keeps a bare-host entry bound to the URL's scheme for http default port", () => {
    const g = new NetworkGuard(["api.internal:80"]);
    expect(g.check("http://api.internal/")).toEqual({ ok: true });
    expect(g.check("https://api.internal/")).toEqual({
      ok: false,
      reason: "endpoint-not-declared",
    });
  });

  it("blocks an undeclared endpoint (VPN-02)", () => {
    const verdict = guard.check("https://evil.example.com:8443/mcp");
    expect(verdict).toEqual({ ok: false, reason: "endpoint-not-declared" });
    expect(() => guard.assert("https://evil.example.com:8443/mcp")).toThrow(NetworkEgressError);
  });

  it("blocks port mismatches", () => {
    expect(guard.check("https://jira.internal:9443/mcp")).toEqual({
      ok: false,
      reason: "endpoint-not-declared",
    });
  });

  it("blocks non-http(s) schemes (SB-07)", () => {
    expect(guard.check("ftp://jira.internal:8443")).toEqual({ ok: false, reason: "disallowed-scheme" });
  });

  it("blocks malformed targets", () => {
    expect(guard.check("not a url")).toEqual({ ok: false, reason: "not-a-url" });
  });

  it("is case-insensitive on hostnames", () => {
    expect(guard.check("https://JIRA.INTERNAL:8443/mcp")).toEqual({ ok: true });
  });
});

describe("SandboxEnforcer", () => {
  const detect = (runtime: string) => () => ({ runtime, evidence: ["test"] }) as ReturnType<
    typeof detectRuntime
  >;

  it("refuses to start when no sandbox is detected", async () => {
    const err = await SandboxEnforcer.create(sandboxConfig(), mcpManifest, {
      detection: detect("none"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxViolationError);
  });

  it("allows a custom-declared boundary without detection", async () => {
    const enforcer = await SandboxEnforcer.create(
      sandboxConfig({ runtime: "custom" }),
      mcpManifest,
      { detection: detect("none") },
    );
    expect(enforcer.detection.runtime).toBe("none");
  });

  it("fails closed on a declared/detected runtime mismatch", async () => {
    const err = await SandboxEnforcer.create(sandboxConfig({ runtime: "firejail" }), mcpManifest, {
      detection: detect("docker"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxViolationError);
    expect((err as Error).message).toContain('declares sandbox runtime "firejail"');
  });

  it("accepts a k8s pod for a docker declaration", async () => {
    const enforcer = await SandboxEnforcer.create(sandboxConfig({ runtime: "docker" }), mcpManifest, {
      detection: detect("k8s-pod"),
    });
    expect(enforcer.detection.runtime).toBe("k8s-pod");
  });

  it("starts in reduced mode when a root is inaccessible, and says so", async () => {
    const missing = "/nonexistent/root";
    const enforcer = await SandboxEnforcer.create(
      sandboxConfig({ runtime: "docker", allowed_paths: [missing] }),
      mcpManifest,
      {
        detection: detect("docker"),
        probe: {
          fileExists: () => false,
          resolveCommand: () => null,
        },
      },
    );
    expect(enforcer.degraded).toBe(true);
    expect(enforcer.report.lost.some((l) => l.area === "filesystem")).toBe(true);
    expect(enforcer.report.summary).toContain("reduced mode");
  });

  it("reports the full capability manifest declaratively", async () => {
    const enforcer = await SandboxEnforcer.create(sandboxConfig(), mcpManifest, {
      detection: detect("docker"),
      probe: { fileExists: () => true, resolveCommand: () => "/usr/bin/npx" },
    });
    expect(enforcer.manifest.schema).toBe("sandy.capability-manifest/v1");
    expect(enforcer.manifest.filesystemRoots).toEqual(["/home/user/sandy-workspace"]);
    expect(enforcer.manifest.networkEndpoints).toEqual(["jira.internal:8443"]);
    expect(enforcer.manifest.subprocesses).toEqual([
      { argv: ["npx", "-y", "@company/crm-mcp-server"], server: "crm" },
    ]);
    expect(enforcer.degraded).toBe(false);
  });
});
