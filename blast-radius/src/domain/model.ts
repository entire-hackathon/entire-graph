/** Domain value objects — the vocabulary every stage speaks. Pure. */

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
}

export function symbolKey(ref: Pick<SymbolRef, "qualifiedName" | "file">): string {
  return `${ref.file ?? "?"}::${ref.qualifiedName}`;
}

export function loc(ref: Pick<SymbolRef, "file" | "line">): string | undefined {
  if (!ref.file) return undefined;
  return ref.line ? `${ref.file}:${ref.line}` : ref.file;
}
