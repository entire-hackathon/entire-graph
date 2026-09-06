/**
 * Graph is evidence, not an oracle.
 *
 * `entire graph` reports its own coverage — `stats.completeness_level`,
 * `partial_failures[]`, `warnings[]` — and Blast Radius used to parse straight
 * past all of it, then present "N nodes, covers every changed symbol" as if the
 * graph were exhaustive. This module turns that self-report into one small value
 * the rest of the pipeline threads through, so the report can say what it knows
 * versus what it is guessing.
 *
 *   complete  — the graph parsed everything in scope; structural edges are trustworthy
 *   partial   — the graph flagged specific files it could not fully analyse, but the
 *               overall shape is intact; only evidence touching those files is suspect
 *   degraded  — `completeness_level: degraded`/`unsafe`: enough of the repo is missing
 *               that the shape itself is unreliable — nothing here is "confirmed"
 */

/** One `partial_failures[]` / `warnings[]` entry from a raw graph result. */
export interface RawGraphNote {
  readonly code?: string;
  readonly severity?: string;
  readonly file_path?: string;
  readonly effect_on_semantic_completeness?: string;
  readonly detail?: string;
}

export interface RawCompletenessInput {
  readonly stats?:
    | { readonly completeness_level?: string; readonly partial_failures?: number }
    | undefined;
  readonly partial_failures?: readonly RawGraphNote[] | undefined;
  readonly warnings?: readonly RawGraphNote[] | undefined;
}

export type CompletenessLevel = "complete" | "partial" | "degraded";

export interface Completeness {
  readonly level: CompletenessLevel;
  /** repo-relative paths the graph flagged as not fully analysed (deduped, sorted). */
  readonly unresolvedFiles: readonly string[];
  /** human-readable lines: every failure + advisory the graph disclosed. */
  readonly notes: readonly string[];
}

export const COMPLETE: Completeness = { level: "complete", unresolvedFiles: [], notes: [] };

const LEVEL_RANK: Record<CompletenessLevel, number> = { complete: 0, partial: 1, degraded: 2 };

const norm = (p: string): string => p.replace(/\\/g, "/");

/**
 * True when a note means "the graph tried to analyse this file and could not
 * fully succeed" — a parse error, a too-large or minified file, a read failure.
 * `*UNSUPPORTED*` ("no parser for this language") is a known, uninteresting blind
 * spot, not a failure; `W_`-coded notes are advisory. Both are still surfaced in
 * `notes`, they just do not mark a file unresolved or move the level.
 */
function marksFileUnresolved(n: RawGraphNote): boolean {
  const code = n.code ?? "";
  return Boolean(n.file_path) && /^E_/.test(code) && !/UNSUPPORTED/.test(code);
}

function noteLine(n: RawGraphNote): string {
  const where = n.file_path ? ` (${norm(n.file_path)})` : "";
  const effect = n.effect_on_semantic_completeness ?? "analysis incomplete";
  return `${n.code ?? "note"}${where}: ${effect}`;
}

/**
 * Read a `Completeness` out of a raw `entire graph diff` / `impact` result.
 * Lenient: every field is optional, and an absent self-report is treated as complete.
 */
export function extractCompleteness(raw: RawCompletenessInput): Completeness {
  const all = [...(raw.partial_failures ?? []), ...(raw.warnings ?? [])];

  const unresolved = new Set<string>();
  for (const n of all) {
    if (marksFileUnresolved(n)) unresolved.add(norm(n.file_path!));
  }

  const notes = all
    .filter((n) => n.effect_on_semantic_completeness || n.file_path)
    .map(noteLine);

  // `entire graph` grades its own coverage as ok | degraded | unsafe. Both
  // degraded and unsafe mean the shape is not to be trusted → our `degraded`.
  // Otherwise, specific flagged files knock us down to `partial`.
  const graphLevel = raw.stats?.completeness_level;
  let level: CompletenessLevel = "complete";
  if (graphLevel === "degraded" || graphLevel === "unsafe") {
    level = "degraded";
  } else if (unresolved.size > 0 || (raw.stats?.partial_failures ?? 0) > 0) {
    level = "partial";
  }

  return { level, unresolvedFiles: [...unresolved].sort(), notes };
}

/** Combine several completeness reports, keeping the least-complete level and the union of the rest. */
export function worstCompleteness(...parts: readonly Completeness[]): Completeness {
  return parts.reduce<Completeness>((acc, c) => {
    const level = LEVEL_RANK[c.level] > LEVEL_RANK[acc.level] ? c.level : acc.level;
    return {
      level,
      unresolvedFiles: [...new Set([...acc.unresolvedFiles, ...c.unresolvedFiles])].sort(),
      notes: [...new Set([...acc.notes, ...c.notes])],
    };
  }, COMPLETE);
}

/** True when `file` is one the graph could not fully analyse. */
export function isUnresolved(c: Completeness, file: string | undefined): boolean {
  return file !== undefined && c.unresolvedFiles.includes(norm(file));
}
