import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServersManifest } from "../config/schema.js";
import {
  orchestratorRequestSchema,
  toOrchestratorRequest,
} from "./request.js";
import type { OrchestratorRequest } from "./orchestrator.js";

/**
 * Recurring report templates (RG-08, issue #15): a small registry of *named*
 * saved requests plus the logic to resolve one to a request.
 *
 * Invariants (the ones that make "saved" not a back door):
 *  - **A template is exactly an `orchestratorRequestSchema` object** — the same
 *    shape `sandy run <request.json>` and `POST /run` take. There is no wider
 *    or different shape for "saved" requests.
 *  - **The same validation as an ad-hoc request.** Every resolved template is
 *    checked by `orchestratorRequestSchema` AND the legal tool catalog —
 *    nothing new is legal because it is "saved" (issue #15).
 *  - **Fail-closed.** A registry file that cannot be read, is not valid JSON,
 *    or has a bad schema is a {@link TemplateError}; a run against it is
 *    refused, never silently dropped or partially loaded.
 *
 * v1 is on-demand re-run (`sandy run <template-name>`, `POST /run {template}`).
 * "On a schedule" is the supervisor's job (the service is designed to be
 * launched by systemd/launchd, design §6) — there is no cron here.
 */

/** A (server, tool) pair a request is allowed to reference. */
export interface ToolRef {
  server: string;
  tool: string;
}

/** A template registry or reference that failed to load/resolve (fail-closed). */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/**
 * The registry's wire format (templates.json): a map of template name to a
 * request in the exact `orchestratorRequestSchema` shape. Names are kebab-case
 * like server names, so they are shell-friendly on the CLI.
 */
export const templateRegistrySchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9-]*$/, { message: "template names must be kebab-case" }),
    orchestratorRequestSchema,
  )
  .superRefine((registry, ctx) => {
    for (const key of Object.keys(registry)) {
      if (key !== "template" && key !== "templates") continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `"${key}" is reserved (a run body selects a template by { "template": <name> }); choose another name`,
      });
    }
  });

export type TemplateRegistry = z.infer<typeof templateRegistrySchema>;

/**
 * The legal tool catalog for a request: the (server, tool) pairs the policy
 * already allows, from the manifest's `allowed_tools` — the same catalog the
 * standalone loop validates plans against (MCP-07).
 */
export function legalToolCatalog(manifest: McpServersManifest): ToolRef[] {
  return manifest.servers.flatMap((s) => s.allowed_tools.map((tool) => ({ server: s.name, tool })));
}

/**
 * Validate a request object the way every entry point must: the
 * `orchestratorRequestSchema` AND the legal tool catalog. A request that would
 * be refused as ad-hoc is refused as a template too — nothing new is legal
 * because it is "saved" (issue #15). Returns the parsed (Zod-defaulted) input
 * on success; callers normalize with `toOrchestratorRequest`.
 */
export function validateRequest(
  input: unknown,
  catalog: readonly ToolRef[],
): { ok: true; data: ReturnType<typeof orchestratorRequestSchema.parse> } | { ok: false; error: string } {
  const parsed = orchestratorRequestSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `invalid orchestrator request: ${issues}` };
  }
  const legal = new Map<string, string[]>();
  for (const { server, tool } of catalog) {
    const list = legal.get(server) ?? [];
    list.push(tool);
    legal.set(server, list);
  }
  for (const task of parsed.data.gather) {
    const toolsForServer = legal.get(task.server);
    if (toolsForServer === undefined) {
      const servers = [...legal.keys()].join(", ") || "none";
      return { ok: false, error: `unknown server "${task.server}" (legal servers: ${servers})` };
    }
    if (!toolsForServer.includes(task.tool)) {
      return {
        ok: false,
        error: `tool "${task.tool}" is not allowed on server "${task.server}" (legal tools: ${toolsForServer.join(", ")})`,
      };
    }
  }
  return { ok: true, data: parsed.data };
}

/**
 * Load a template registry file (fail-closed). The file must be a JSON object
 * mapping kebab-case names to `orchestratorRequestSchema` objects.
 */
export async function loadTemplateRegistry(filePath: string): Promise<TemplateRegistry> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    throw new TemplateError(`cannot read template registry ${filePath}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new TemplateError(`template registry ${filePath} is not valid JSON: ${(err as Error).message}`);
  }
  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    for (const key of Object.keys(json)) {
      if (!/^[a-z][a-z0-9-]*$/.test(key)) {
        throw new TemplateError(
          `invalid template registry ${filePath}:\n  - ${key}: template names must be kebab-case`,
        );
      }
    }
  }
  const result = templateRegistrySchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new TemplateError(`invalid template registry ${filePath}:\n${issues}`);
  }
  return result.data;
}

/**
 * Resolve a template name to a runnable request, validating it exactly like an
 * ad-hoc request (schema + legal tool catalog). Throws a {@link TemplateError}
 * naming the template on any failure — unknown name, invalid request, or a
 * request that names a server/tool outside the policy.
 */
export function resolveTemplate(
  registry: TemplateRegistry,
  name: string,
  catalog: readonly ToolRef[],
): OrchestratorRequest {
  const entry = registry[name];
  if (entry === undefined) {
    const names = Object.keys(registry).join(", ") || "none";
    throw new TemplateError(`unknown template "${name}" (available: ${names})`);
  }
  const validated = validateRequest(entry, catalog);
  if (!validated.ok) {
    throw new TemplateError(`template "${name}" is not a legal request: ${validated.error}`);
  }
  return toOrchestratorRequest(validated.data);
}

/**
 * Parse a `POST /run` body that may either be a raw request or a template
 * reference (`{ "template": "<name>" }`). A body with a `template` field is
 * ONLY a template reference (fail-closed: mixing the two is a 400, not a
 * guess). Returns the resolved request plus the template name when one was
 * used (for audit provenance). Throws a {@link TemplateError} on any problem
 * (unknown template, illegal request, no registry configured).
 */
export function parseRunBody(
  body: unknown,
  registry: TemplateRegistry | undefined,
  catalog: readonly ToolRef[],
): { request: OrchestratorRequest; template?: string } {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const template = (body as { template?: unknown }).template;
    if (template !== undefined) {
      if (typeof template !== "string" || template.trim().length === 0) {
        throw new TemplateError('a run body with "template" must give its name as a string: { "template": "<name>" }');
      }
      const name = template.trim();
      if (registry === undefined) {
        throw new TemplateError(
          `run body references template "${name}", but no template registry is configured (set templates.path in sandy.json)`,
        );
      }
      return { request: resolveTemplate(registry, name, catalog), template: name };
    }
  }
  const validated = validateRequest(body ?? {}, catalog);
  if (!validated.ok) throw new TemplateError(validated.error);
  return { request: toOrchestratorRequest(validated.data) };
}
