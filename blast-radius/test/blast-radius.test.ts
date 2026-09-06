import { describe, expect, it } from "vitest";
import { computeBlastRadius } from "../src/domain/blast-radius.js";
import { toChangeSet, toRadiusNodes } from "../src/domain/graph-mapping.js";
import { rawDiffResult, rawImpactResult } from "../src/domain/graph-schema.js";
import type { ChangedSymbol, RadiusNode, SymbolRef } from "../src/domain/model.js";

const ref = (qn: string): SymbolRef => ({
  name: qn,
  qualifiedName: qn,
  kind: "function",
  file: `src/${qn}.ts`,
  line: 1,
  external: false,
});
const changed = (qn: string, deps = 1): ChangedSymbol => ({
  ref: ref(qn),
  changeType: "body_changed",
  dependentsCount: deps,
  oldSignature: undefined,
  newSignature: undefined,
});
const node = (o: Partial<RadiusNode> & { qn: string }): RadiusNode => ({
  ref: { ...ref(o.qn), file: `${o.qn}.ts` },
  section: "callers",
  relation: "CALLED_BY",
  distance: 1,
  viaChain: [],
  originSymbols: ["X"],
  isTest: false,
  confidence: "confirmed",
  ...o,
});

describe("toChangeSet", () => {
  it("keeps symbols, drops module rows and added-field noise", () => {
    const cs = toChangeSet(
      rawDiffResult.parse({
        base: "a",
        head: "b",
        files: [
          {
            path: "s.ts",
            status: "M",
            language: "TypeScript",
            changes: [
              { type: "body_changed", kind: "module", name: "s.ts", dependents_count: 0 },
              { type: "added", kind: "field", name: "X.f", dependents_count: 9 },
              {
                type: "signature_changed",
                kind: "method",
                name: "Db.query",
                dependents_count: 12,
                after_start_line: 5,
              },
            ],
          },
        ],
      }),
    );
    expect(cs.symbols.map((s) => s.ref.qualifiedName)).toEqual(["Db.query"]);
    expect(cs.symbols[0]?.dependentsCount).toBe(12);
  });
});

describe("toRadiusNodes", () => {
  it("tags the origin and flags a test file caller", () => {
    const nodes = toRadiusNodes(
      rawImpactResult.parse({
        query: "Db.query",
        callers: {
          total: 2,
          entries: [
            { endpoint: { id: "1", name: "byId", qualified_name: "Repo.byId", file_path: "src/repo.ts" }, relation: "CALLS", direction: "in", depth: 1 },
            { endpoint: { id: "2", name: "repo_test", qualified_name: "repo_test", file_path: "test/repo.test.ts" }, relation: "CALLS", direction: "in", depth: 2, via: "Repo.byId" },
          ],
        },
      }),
      "Db.query",
    );
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.originSymbols[0] === "Db.query")).toBe(true);
    expect(nodes.find((n) => n.ref.qualifiedName === "repo_test")?.isTest).toBe(true);
  });
});

describe("computeBlastRadius", () => {
  it("dedupes by (file,name), keeps min distance, unions origins", () => {
    const r = computeBlastRadius(
      [changed("A"), changed("B")],
      [
        [node({ qn: "shared", distance: 3, originSymbols: ["A"] })],
        [node({ qn: "shared", distance: 1, originSymbols: ["B"] })],
      ],
    );
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]?.distance).toBe(1);
    expect([...(r.nodes[0]?.originSymbols ?? [])].sort()).toEqual(["A", "B"]);
  });

  it("drops a node that is itself a changed symbol", () => {
    const r = computeBlastRadius([changed("A")], [[node({ qn: "A" }), node({ qn: "down" })]]);
    expect(r.nodes.map((n) => n.ref.qualifiedName)).toEqual(["down"]);
  });

  it("counts section totals", () => {
    const r = computeBlastRadius(
      [changed("A")],
      [[node({ qn: "c1" }), node({ qn: "t1", section: "type_consumers", relation: "USES_TYPE" })]],
    );
    expect(r.sectionTotals.callers).toBe(1);
    expect(r.sectionTotals.type_consumers).toBe(1);
  });
});
