import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConfirmationRequiredError,
  FileManager,
  FileOpError,
  PathConfinement,
  SandboxViolationError,
  detectFormat,
  validateContent,
  isIgnoredByPatterns,
  type PolicyConfig,
} from "../src/index.js";

let workspace: string;
let outside: string;

function policy(over: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    confirmation_required: ["delete", "overwrite"],
    undo_depth: 10,
    dry_run_default: false,
    audit_payload_logging: false,
    ignore_patterns: ["node_modules/", ".git/", "*.env"],
    ...over,
  } as PolicyConfig;
}

function manager(over: Partial<PolicyConfig> = {}, journalDepth?: number): FileManager {
  const p = policy(over);
  return new FileManager({
    confinement: new PathConfinement([workspace]),
    policy: journalDepth !== undefined ? { ...p, undo_depth: journalDepth } : p,
  });
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "sandy-fm-"));
  outside = await mkdtemp(path.join(tmpdir(), "sandy-fm-out-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("FileManager: file CRUD (FM-01)", () => {
  it("creates, reads, and deletes a file (with confirmations where required)", async () => {
    const fm = manager();
    await fm.write("notes/hello.txt", "hi there");
    expect(await readFile(path.join(workspace, "notes/hello.txt"), "utf8")).toBe("hi there");

    const read = await fm.read("notes/hello.txt");
    expect(read.content).toBe("hi there");
    expect(read.format).toBe("text");

    await fm.deleteFile("notes/hello.txt", { confirmed: true });
    expect(await existsAny(path.join(workspace, "notes/hello.txt"))).toBe(false);
  });

  it("lists directory contents, skipping ignored entries (FM-07)", async () => {
    const fm = manager();
    await writeFile(path.join(workspace, "listdir.txt"), "x");
    await mkdir(path.join(workspace, "node_modules"), { recursive: true });
    await writeFile(path.join(workspace, "node_modules/pkg.js"), "x");
    await writeFile(path.join(workspace, ".env"), "SECRET=1");

    const entries = await fm.list(".");
    expect(entries).toContain("listdir.txt");
    expect(entries.some((e) => e.includes("node_modules"))).toBe(false);
    expect(entries).not.toContain(".env");
  });

  it("rejects reading outside the sandbox (FM-03)", async () => {
    const fm = manager();
    const err = await fm.read("/etc/passwd").catch((e) => e);
    expect(err).toBeInstanceOf(SandboxViolationError);
  });

  it("rejects '..' traversal", async () => {
    const fm = manager();
    const err = await fm.write("../../escape.txt", "nope").catch((e) => e);
    expect(err).toBeInstanceOf(SandboxViolationError);
  });
});

describe("FileManager: confirmations (FM-04)", () => {
  it("requires confirmation to overwrite an existing file", async () => {
    const fm = manager();
    await fm.write("conf.txt", "v1");
    const err = await fm.write("conf.txt", "v2").catch((e) => e);
    expect(err).toBeInstanceOf(ConfirmationRequiredError);
    expect((await fm.read("conf.txt")).content).toBe("v1");
    await fm.write("conf.txt", "v2", { confirmed: true });
    expect((await fm.read("conf.txt")).content).toBe("v2");
  });

  it("requires confirmation to delete", async () => {
    const fm = manager();
    await fm.write("del.txt", "x");
    const err = await fm.deleteFile("del.txt").catch((e) => e);
    expect(err).toBeInstanceOf(ConfirmationRequiredError);
    expect(await existsAny(path.join(workspace, "del.txt"))).toBe(true);
  });

  it("rename() requires overwrite confirmation when the destination already exists", async () => {
    // rename() used to gate only on the 'rename' kind and never checked whether
    // the destination existed, so it silently clobbered an existing file under
    // the default policy that mandatorily requires 'overwrite' confirmation for
    // the equivalent write() (GHSA-rm4r-g5vv-mvrm).
    const fm = manager();
    await fm.write("src.txt", "new content", { confirmed: true });
    await fm.write("dst.txt", "existing content", { confirmed: true });
    // No confirmation: the 'rename' kind is not in the default policy, but the
    // new 'overwrite' gate (forced-minimum) must still reject the clobber.
    await expect(fm.rename("src.txt", "dst.txt")).rejects.toThrow(ConfirmationRequiredError);
    // The destination is untouched by the refused rename.
    expect((await fm.read("dst.txt")).content).toBe("existing content");
    expect(await existsAny(path.join(workspace, "src.txt"))).toBe(true);
  });

  it("rename() over an existing destination succeeds once overwrite is confirmed", async () => {
    const fm = manager();
    await fm.write("src.txt", "new content", { confirmed: true });
    await fm.write("dst.txt", "existing content", { confirmed: true });
    // 'overwrite' is a forced-minimum policy kind, so a single {confirmed:true}
    // satisfies both the 'rename' and the 'overwrite' gates.
    const result = await fm.rename("src.txt", "dst.txt", { confirmed: true });
    expect(result.applied).toBe(true);
    expect((await fm.read("dst.txt")).content).toBe("new content");
    expect(await existsAny(path.join(workspace, "src.txt"))).toBe(false);
  });

  it("can make policy stricter: require confirmation for create", async () => {
    const fm = manager({ confirmation_required: ["delete", "overwrite", "create"] });
    const err = await fm.write("strict.txt", "x").catch((e) => e);
    expect(err).toBeInstanceOf(ConfirmationRequiredError);
    await fm.write("strict.txt", "x", { confirmed: true });
    expect(await existsAny(path.join(workspace, "strict.txt"))).toBe(true);
  });
});

describe("FileManager: dry-run (FM-06)", () => {
  it("plans without touching the filesystem", async () => {
    const fm = manager();
    const result = await fm.write("dryrun.txt", "never written", { dryRun: true });
    expect(result.applied).toBe(false);
    expect(await existsAny(path.join(workspace, "dryrun.txt"))).toBe(false);

    await fm.write("drydel.txt", "x");
    const del = await fm.deleteFile("drydel.txt", { dryRun: true });
    expect(del.applied).toBe(false);
    expect(await existsAny(path.join(workspace, "drydel.txt"))).toBe(true);
  });
});

describe("FileManager: directories (FM-02)", () => {
  it("creates, renames, and deletes directories", async () => {
    const fm = manager();
    await fm.createDirectory("dirtree");
    await fm.createDirectory("dirtree/a");
    expect(await existsAny(path.join(workspace, "dirtree/a"))).toBe(true);

    await fm.rename("dirtree/a", "dirtree/b", { confirmed: true });
    expect(await existsAny(path.join(workspace, "dirtree/a"))).toBe(false);
    expect(await existsAny(path.join(workspace, "dirtree/b"))).toBe(true);

    await fm.deleteDirectory("dirtree", { confirmed: true });
    expect(await existsAny(path.join(workspace, "dirtree"))).toBe(false);
  });

  it("does not create parent directories implicitly", async () => {
    const fm = manager();
    const err = await fm.createDirectory("nested/child").catch((e) => e);
    expect(err).toBeInstanceOf(FileOpError);
    expect((err as FileOpError).reason).toBe("not-found");
    expect(await existsAny(path.join(workspace, "nested"))).toBe(false);
  });

  it("refuses to rename to a path outside the sandbox", async () => {
    const fm = manager();
    await fm.write("mv.txt", "x");
    const err = await fm.rename("mv.txt", "/tmp/sandy-fm-escape.txt", { confirmed: true }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxViolationError);
  });

  it("refuses to rename into an ignored path", async () => {
    const fm = manager();
    await fm.write("mv2.txt", "x");
    const err = await fm.rename("mv2.txt", "node_modules/mv2.txt", { confirmed: true }).catch((e) => e);
    expect(err).toBeInstanceOf(FileOpError);
    expect((err as FileOpError).reason).toBe("ignored");
  });
});

describe("FileManager: ignore patterns (FM-07)", () => {
  it("isIgnoredByPatterns matches segments and globs", () => {
    const patterns = ["node_modules/", ".git/", "*.env", "dist"];
    expect(isIgnoredByPatterns("node_modules/pkg/index.js", patterns)).toBe(true);
    expect(isIgnoredByPatterns(".git/config", patterns)).toBe(true);
    expect(isIgnoredByPatterns("secrets/app.env", patterns)).toBe(true);
    expect(isIgnoredByPatterns("dist/bundle.js", patterns)).toBe(true);
    expect(isIgnoredByPatterns("src/app.ts", patterns)).toBe(false);
    expect(isIgnoredByPatterns("docs/notes.txt", patterns)).toBe(false);
  });

  it("refuses mutations on ignored paths", async () => {
    const fm = manager();
    const err = await fm.write("app.env", "KEY=1").catch((e) => e);
    expect(err).toBeInstanceOf(FileOpError);
    expect((err as FileOpError).reason).toBe("ignored");
    expect(await existsAny(path.join(workspace, "app.env"))).toBe(false);
  });

  it("list() applies ignore_patterns relative to the confinement root, not the queried directory", async () => {
    const fm = manager({ ignore_patterns: ["secrets/*.key"] });
    // Create the files directly on disk: fm.write("secrets/api.key") would be
    // refused by assertNotIgnored (the path matches the ignore pattern), which
    // is exactly why the leak was reachable only through list(), not write().
    await mkdir(path.join(workspace, "secrets"), { recursive: true });
    await writeFile(path.join(workspace, "secrets/api.key"), "sekrit");
    await writeFile(path.join(workspace, "secrets/readme.md"), "not secret");
    // A direct list() of the subdirectory must still exclude the pattern
    // (GHSA-r885-qm59-2mxf): walk() used to match ignore patterns against the
    // queried directory itself, so "secrets/*.key" never matched "api.key".
    const entries = await fm.list("secrets");
    expect(entries).not.toContain("api.key");
    expect(entries).toContain("readme.md");
  });
});

describe("FileManager: formats (FM-08)", () => {
  it("detects formats from extensions", () => {
    expect(detectFormat("a.txt")).toBe("text");
    expect(detectFormat("a.md")).toBe("markdown");
    expect(detectFormat("a.csv")).toBe("csv");
    expect(detectFormat("a.json")).toBe("json");
    expect(detectFormat("a.xyz")).toBe("text");
  });

  it("rejects invalid JSON content on write", async () => {
    const fm = manager();
    const err = await fm.write("bad.json", "{ not json").catch((e) => e);
    expect(err).toBeInstanceOf(FileOpError);
    expect((err as FileOpError).reason).toBe("format-invalid");
    expect(await existsAny(path.join(workspace, "bad.json"))).toBe(false);
  });

  it("rejects inconsistent CSV on write", async () => {
    const fm = manager();
    const err = await fm.write("bad.csv", "a,b,c\n1,2").catch((e) => e);
    expect(err).toBeInstanceOf(FileOpError);
    expect((err as FileOpError).reason).toBe("format-invalid");
  });

  it("accepts valid JSON and CSV", async () => {
    const fm = manager();
    await fm.write("good.json", JSON.stringify({ a: 1 }));
    await fm.write("good.csv", "a,b\n1,2\n3,4");
    expect(validateContent("json", '{"a":1}')).toBeNull();
    expect(validateContent("csv", "a,b\n1,2")).toBeNull();
  });
});

describe("FileManager: undo journal (FM-05)", () => {
  it("undoes the last N operations, in reverse order", async () => {
    const fm = manager();
    await fm.write("undo.txt", "v1");
    await fm.write("undo.txt", "v2", { confirmed: true });
    await fm.deleteFile("undo.txt", { confirmed: true });

    // undo delete -> file restored with v2
    const r1 = await fm.undo();
    expect(r1?.op).toBe("delete-file");
    expect(await readFile(path.join(workspace, "undo.txt"), "utf8")).toBe("v2");

    // undo overwrite -> v1
    const r2 = await fm.undo();
    expect(r2?.op).toBe("write-file");
    expect(await readFile(path.join(workspace, "undo.txt"), "utf8")).toBe("v1");
  });

  it("restores a deleted directory subtree on undo", async () => {
    const fm = manager();
    await fm.write("tree/one.txt", "1");
    await fm.write("tree/sub/two.txt", "2");
    await fm.deleteDirectory("tree", { confirmed: true });
    expect(await existsAny(path.join(workspace, "tree"))).toBe(false);

    await fm.undo();
    expect(await readFile(path.join(workspace, "tree/one.txt"), "utf8")).toBe("1");
    expect(await readFile(path.join(workspace, "tree/sub/two.txt"), "utf8")).toBe("2");
  });

  it("honor undo_depth: older operations are not undoable", async () => {
    const fm = manager({}, 1);
    await fm.write("depth.txt", "v1");
    await fm.write("depth.txt", "v2", { confirmed: true });
    const r = await fm.undo();
    expect(r?.op).toBe("write-file");
    // journal is now empty
    expect(await fm.undo()).toBeUndefined();
  });

  it("undo of rename reverses the move", async () => {
    const fm = manager();
    await fm.write("ren.txt", "x");
    await fm.rename("ren.txt", "ren-moved.txt", { confirmed: true });
    await fm.undo();
    expect(await existsAny(path.join(workspace, "ren.txt"))).toBe(true);
    expect(await existsAny(path.join(workspace, "ren-moved.txt"))).toBe(false);
  });

  it("undo re-checks confinement, refusing to follow a symlink swapped in after the original mutation", async () => {
    const fm = manager();
    await fm.write("link-target.txt", "original content");
    // Swap the file for a symlink pointing outside the confined root before undo runs.
    await rm(path.join(workspace, "link-target.txt"));
    await symlink(outside, path.join(workspace, "link-target.txt"));

    // reverse() must re-resolve the journaled path through PathConfinement and
    // refuse the symlink-escape (SandboxViolationError), rather than following
    // the symlink with a bare fs call (TOCTOU escape, GHSA-w84c-rwhv-mrgx).
    await expect(fm.undo()).rejects.toThrow(SandboxViolationError);
    const leaked = await stat(path.join(outside, "should-not-exist")).catch(() => null);
    expect(leaked).toBeNull();
  });
});

async function existsAny(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
