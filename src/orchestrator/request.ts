import { z } from "zod";
import type { GatherTask, OrchestratorRequest } from "./orchestrator.js";

/**
 * The wire format for an orchestrator request (what the host LLM / plugin /
 * CLI supplies). Kept as its own schema so the CLI can validate a request
 * file and the plugin can validate tool bodies with the same rules.
 */
export const gatherTaskSchema = z
  .object({
    id: z.string().min(1).describe("Stable id used in provenance references"),
    server: z.string().min(1).describe("MCP server name"),
    tool: z.string().min(1).describe("Tool to call on that server"),
    args: z.record(z.string(), z.unknown()).default({}),
    description: z.string().min(1).optional(),
  })
  .strict();

export const reportSpecSchema = z
  .object({
    title: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
  })
  .strict()
  .optional();

export const orchestratorRequestSchema = z
  .object({
    goal: z.string().min(1).describe("What the user asked for, in their words"),
    gather: z.array(gatherTaskSchema).min(1, { message: "at least one gather task is required" }),
    report: reportSpecSchema,
  })
  .strict();

export type OrchestratorRequestInput = z.infer<typeof orchestratorRequestSchema>;

/**
 * Normalize a parsed request (with Zod defaults applied) into the runtime
 * {@link OrchestratorRequest} shape — `args` and the optional report field
 * are materialized.
 */
export function toOrchestratorRequest(input: OrchestratorRequestInput): OrchestratorRequest {
  const gather: GatherTask[] = input.gather.map((t) => ({
    id: t.id,
    server: t.server,
    tool: t.tool,
    args: t.args,
    ...(t.description !== undefined ? { description: t.description } : {}),
  }));
  return {
    goal: input.goal,
    gather,
    ...(input.report !== undefined ? { report: input.report } : {}),
  };
}
