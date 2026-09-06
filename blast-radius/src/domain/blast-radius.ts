/**
 * Fold the per-changed-symbol impact node lists into one blast radius.
 *  - dedupe by (file, qualifiedName): keep the SHORTEST distance, union origins
 *  - a node that is itself a changed symbol is the origin, not the blast — dropped
 *  - drop external callees (fmt.Errorf etc.) as review noise
 */
import type { BlastRadius, ChangedSymbol, RadiusNode, RadiusSection } from "./model.js";
import { symbolKey } from "./model.js";

function emptyTotals(): Record<RadiusSection, number> {
  return { callers: 0, callees: 0, type_consumers: 0, data_flows: 0, co_changes: 0, siblings: 0 };
}

function merge(a: RadiusNode, b: RadiusNode): RadiusNode {
  const origins = new Set([...a.originSymbols, ...b.originSymbols]);
  const closer = b.distance < a.distance ? b : a;
  return {
    ...closer,
    originSymbols: [...origins],
    viaChain: closer.viaChain.length > 0 ? closer.viaChain : a.viaChain,
    isTest: a.isTest || b.isTest,
  };
}

export function computeBlastRadius(
  origin: readonly ChangedSymbol[],
  nodeLists: readonly (readonly RadiusNode[])[],
): BlastRadius {
  const originKeys = new Set(origin.map((s) => symbolKey(s.ref)));
  const originNames = new Set(origin.map((s) => s.ref.qualifiedName));
  const byKey = new Map<string, RadiusNode>();

  for (const list of nodeLists) {
    for (const node of list) {
      if (node.ref.external && node.section === "callees") continue;
      const key = symbolKey(node.ref);
      if (originKeys.has(key) || originNames.has(node.ref.qualifiedName)) continue;
      const existing = byKey.get(key);
      byKey.set(key, existing ? merge(existing, node) : node);
    }
  }

  const nodes = [...byKey.values()].sort(
    (a, b) => a.distance - b.distance || a.ref.qualifiedName.localeCompare(b.ref.qualifiedName),
  );
  const sectionTotals = emptyTotals();
  for (const n of nodes) sectionTotals[n.section] += 1;
  return { origin: [...origin], nodes, sectionTotals };
}
