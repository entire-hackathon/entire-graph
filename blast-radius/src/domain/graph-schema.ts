/**
 * Lenient zod schemas for the raw JSON that `entire graph` emits.
 * The graph schema is frozen-but-additive, so: passthrough everywhere,
 * most fields optional. Everything that enters the domain is parsed here first.
 */
import { z } from "zod";

export const rawEntityChange = z
  .object({
    type: z.string(),
    kind: z.string(),
    name: z.string(),
    new_name: z.string().optional(),
    old_signature: z.string().optional(),
    new_signature: z.string().optional(),
    new_path: z.string().optional(),
    before_start_line: z.number().int().optional(),
    after_start_line: z.number().int().optional(),
    dependents_count: z.number().int().default(0),
    reconciliation: z.string().optional(),
  })
  .passthrough();

export const rawFileChange = z
  .object({
    path: z.string(),
    status: z.string(),
    language: z.string().optional(),
    changes: z.array(rawEntityChange).default([]),
  })
  .passthrough();

export const rawDiffResult = z
  .object({
    base: z.string(),
    head: z.string(),
    checkpoint: z.string().optional(),
    files: z.array(rawFileChange).default([]),
  })
  .passthrough();
export type RawDiffResult = z.infer<typeof rawDiffResult>;

export const rawEndpoint = z
  .object({
    id: z.string().default(""),
    name: z.string().default(""),
    qualified_name: z.string().optional(),
    kind: z.string().optional(),
    file_path: z.string().optional(),
    start_line: z.number().int().optional(),
    external: z.boolean().optional(),
  })
  .passthrough();

export const rawImpactEntry = z
  .object({
    endpoint: rawEndpoint,
    relation: z.string().optional(),
    direction: z.string().optional(),
    depth: z.number().int().optional(),
    via: z.string().optional(),
  })
  .passthrough();

export const rawImpactSection = z
  .object({ total: z.number().int().default(0), entries: z.array(rawImpactEntry).default([]) })
  .passthrough();

export const rawImpactResult = z
  .object({
    query: z.string().default(""),
    disambiguation_required: z.boolean().default(false),
    callers: rawImpactSection.default({ total: 0, entries: [] }),
    callees: rawImpactSection.default({ total: 0, entries: [] }),
    type_consumers: rawImpactSection.default({ total: 0, entries: [] }),
    data_flows: rawImpactSection.default({ total: 0, entries: [] }),
    co_changes: rawImpactSection.default({ total: 0, entries: [] }),
    siblings: rawImpactSection.default({ total: 0, entries: [] }),
  })
  .passthrough();
export type RawImpactResult = z.infer<typeof rawImpactResult>;

export const IMPACT_SECTIONS = [
  "callers",
  "callees",
  "type_consumers",
  "data_flows",
  "co_changes",
  "siblings",
] as const;
export type ImpactSectionName = (typeof IMPACT_SECTIONS)[number];
