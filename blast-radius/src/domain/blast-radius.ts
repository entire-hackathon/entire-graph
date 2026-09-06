/**
 * Fold the per-changed-symbol impact node lists into one blast radius.
 *  - dedupe by (file, qualifiedName): keep the SHORTEST distance, union origins
 *  - a node that is itself a changed symbol is the origin, not the blast — dropped
 *  - drop external callees (fmt.Errorf etc.) as review noise
 */
import { COMPLETE, isUnresolved, type Completeness } from "./completeness.js";
import type {
  BlastRadius,
  ChangedSymbol,
  Confidence,
  OriginEdge,
  RadiusNode,
  RadiusSection,
} from "./model.js";
import { symbolKey } from "./model.js";

function emptyTotals(): Record<RadiusSection, number> {
  return { callers: 0, callees: 0, type_consumers: 0, data_flows: 0, co_changes: 0, siblings: 0 };
}

const CONFIDENCE_RANK: Record<Confidence, number> = { confirmed: 0, heuristic: 1, partial: 2 };

function weaker(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[b] > CONFIDENCE_RANK[a] ? b : a;
}

function merge(a: RadiusNode, b: RadiusNode): RadiusNode {
  const origins = new Set([...a.originSymbols, ...b.originSymbols]);
  const closer = b.distance < a.distance ? b : a;
  return {
    ...closer,
    originSymbols: [...origins],
    viaChain: closer.viaChain.length > 0 ? closer.viaChain : a.viaChain,
    isTest: a.isTest || b.isTest,
    confidence: weaker(a.confidence, b.confidence),
  };
}

/**
 * Grade one node against what the graph disclosed about its coverage:
 *  - degraded run, or the node's own file was not fully analysed → `partial`
 *  - otherwise keep the provisional grade from the relation type
 *    (structural edge → `confirmed`, lexical/historical → `heuristic`)
 */
function gradeConfidence(node: RadiusNode, c: Completeness): Confidence {
  if (c.level === "degraded" || isUnresolved(c, node.ref.file)) return "partial";
  return node.confidence;
}

export function computeBlastRadius(
  origin: readonly ChangedSymbol[],
  nodeLists: readonly (readonly RadiusNode[])[],
  completeness: Completeness = COMPLETE,
): BlastRadius {
  const originKeys = new Set(origin.map((s) => symbolKey(s.ref)));
  const originNames = new Set(origin.map((s) => s.ref.qualifiedName));
  const byKey = new Map<string, RadiusNode>();
  const edgeSeen = new Set<string>();
  const originEdges: OriginEdge[] = [];

  for (const list of nodeLists) {
    for (const node of list) {
      if (node.ref.external && node.section === "callees") continue;
      const key = symbolKey(node.ref);
      if (originKeys.has(key) || originNames.has(node.ref.qualifiedName)) {
        // one changed symbol calling another: keep it as an edge for the diagram
        if (node.section === "callers") {
          for (const o of node.originSymbols) {
            if (o === node.ref.qualifiedName || !originNames.has(o)) continue;
            const e = `${node.ref.qualifiedName} ${o}`;
            if (!edgeSeen.has(e)) {
              edgeSeen.add(e);
              originEdges.push({ from: node.ref.qualifiedName, to: o });
            }
          }
        }
        continue;
      }
      const existing = byKey.get(key);
      byKey.set(key, existing ? merge(existing, node) : node);
    }
  }

  const nodes = [...byKey.values()]
    .map((n) => ({ ...n, confidence: gradeConfidence(n, completeness) }))
    .sort(
      (a, b) => a.distance - b.distance || a.ref.qualifiedName.localeCompare(b.ref.qualifiedName),
    );
  const sectionTotals = emptyTotals();
  for (const n of nodes) sectionTotals[n.section] += 1;
  return { origin: [...origin], nodes, sectionTotals, originEdges, completeness };
}
