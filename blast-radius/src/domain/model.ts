/** Domain value objects — the vocabulary every stage speaks. Pure. */

import type { Completeness } from "./completeness.js";

/**
 * How much to trust one piece of evidence.
 *   confirmed — a structural graph edge (CALLS / CALLED_BY / USES_TYPE …) from a fully-parsed file
 *   heuristic — a lexical or historical signal (scope-creep verdict, co-change) — verify against source
 *   partial   — the graph could not fully analyse the file involved, or the run was degraded
 */
export type Confidence = "confirmed" | "heuristic" | "partial";

export interface SymbolRef {
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: string | undefined;
  readonly file: string | undefined;
  readonly line: number | undefined;
  readonly external: boolean;
}

export type ChangeType =
  | "added"
  | "removed"
  | "renamed"
  | "signature_changed"
  | "body_changed"
  | "unknown";

export interface ChangedSymbol {
  readonly ref: SymbolRef;
  readonly changeType: ChangeType;
  readonly dependentsCount: number;
  readonly oldSignature: string | undefined;
  readonly newSignature: string | undefined;
}

export interface ChangeSet {
  readonly base: string;
  readonly head: string;
  readonly checkpoint: string | undefined;
  readonly symbols: readonly ChangedSymbol[];
  readonly changedFiles: readonly string[];
  /** what `entire graph diff` said about its own coverage of this range. */
  readonly completeness: Completeness;
}

export type RadiusSection =
  | "callers"
  | "callees"
  | "type_consumers"
  | "data_flows"
  | "co_changes"
  | "siblings";

export interface RadiusNode {
  readonly ref: SymbolRef;
  readonly section: RadiusSection;
  readonly relation: string;
  readonly distance: number;
  readonly viaChain: readonly string[];
  readonly originSymbols: readonly string[];
  readonly isTest: boolean;
  /** `confirmed` for a structural edge from a parsed file; `partial` when the graph was unsure. */
  readonly confidence: Confidence;
}

/** A call edge between two changed symbols (`from` calls `to`) — for the diagram. */
export interface OriginEdge {
  readonly from: string;
  readonly to: string;
}

export interface BlastRadius {
  readonly origin: readonly ChangedSymbol[];
  readonly nodes: readonly RadiusNode[];
  readonly sectionTotals: Readonly<Record<RadiusSection, number>>;
  readonly originEdges: readonly OriginEdge[];
  /** worst of the diff's coverage and every per-symbol impact query's coverage. */
  readonly completeness: Completeness;
}

export interface IntentModel {
  readonly source: string;
  readonly text: string;
  readonly keywords: readonly string[];
}

export type Severity = "high" | "medium" | "low";

export interface Finding {
  readonly symbol: SymbolRef;
  readonly severity: Severity;
  readonly reason: string;
  readonly dependentsCount: number;
  readonly evidence: readonly string[];
  /**
   * The scope-creep verdict is lexical, so it is `heuristic` — verify against source.
   * It drops to `partial` when the graph could not fully analyse the changed file
   * (the dependent count and reachability behind it may be wrong).
   */
  readonly confidence: Confidence;
}

export interface TestCandidate {
  readonly ref: SymbolRef;
  readonly distance: number;
  readonly covers: readonly string[];
}

export interface TestPlan {
  readonly framework: string;
  readonly selected: readonly TestCandidate[];
  readonly command: string | null;
  readonly coverageGaps: readonly string[];
}

export interface AnalysisReport {
  readonly schemaVersion: "1.0.0";
  readonly generatedAt: string;
  readonly range: { base: string; head: string; checkpoint: string | undefined };
  readonly intent: IntentModel | null;
  readonly changedSymbols: readonly ChangedSymbol[];
  readonly radius: BlastRadius;
  readonly findings: readonly Finding[];
  readonly testPlan: TestPlan;
  /** the graph's own coverage self-report for this analysis (= `radius.completeness`). */
  readonly completeness: Completeness;
}

export function symbolKey(ref: Pick<SymbolRef, "qualifiedName" | "file">): string {
  return `${ref.file ?? "?"}::${ref.qualifiedName}`;
}

export function loc(ref: Pick<SymbolRef, "file" | "line">): string | undefined {
  if (!ref.file) return undefined;
  return ref.line ? `${ref.file}:${ref.line}` : ref.file;
}
