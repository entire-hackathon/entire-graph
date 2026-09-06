import { describe, expect, it, vi } from "vitest";
import {
  buildCreateSchema,
  buildCreateTable,
  buildInsert,
  exportRow,
  qualifyTable,
  toReportRow,
  toSqlParameters,
  type DatabricksConfig,
} from "../src/adapters/databricks.js";
import { COMPLETE } from "../src/domain/completeness.js";
import type { AnalysisReport } from "../src/domain/model.js";

const report = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
  schemaVersion: "1.0.0",
  generatedAt: "2026-09-06T00:00:00.000Z",
  range: { base: "aaa", head: "bbb", checkpoint: undefined },
  intent: { source: "pr-body", text: "rate limit", keywords: ["rate", "limit"] },
  changedSymbols: [],
  radius: {
    origin: [],
    nodes: [
      { ref: { name: "a", qualifiedName: "a", kind: "function", file: "a.ts", line: 1, external: false }, section: "callers", relation: "CALLED_BY", distance: 1, viaChain: [], originSymbols: ["x"], isTest: false, confidence: "confirmed" },
      { ref: { name: "b", qualifiedName: "b", kind: "function", file: "b.ts", line: 1, external: false }, section: "callers", relation: "CALLED_BY", distance: 1, viaChain: [], originSymbols: ["y"], isTest: false, confidence: "partial" },
    ],
    sectionTotals: { callers: 2, callees: 0, type_consumers: 0, data_flows: 0, co_changes: 0, siblings: 0 },
    originEdges: [],
    completeness: COMPLETE,
  },
  findings: [
    { symbol: { name: "q", qualifiedName: "Db.query", kind: "method", file: "db.ts", line: 1, external: false }, severity: "high", reason: "x", dependentsCount: 20, evidence: [], confidence: "partial" },
  ],
  testPlan: { framework: "vitest", selected: [], command: null, coverageGaps: ["Db.query"] },
  completeness: { level: "degraded", unresolvedFiles: ["db.ts"], notes: ["E_PARSE_ERROR (db.ts): bad"] },
  ...over,
});

describe("toReportRow", () => {
  it("flattens the report into scalar columns", () => {
    const row = toReportRow(report(), { repo: "acme/app", prNumber: 7, runAt: "2026-09-06T01:00:00.000Z" });
    expect(row).toMatchObject({
      repo: "acme/app",
      pr_number: 7,
      base: "aaa",
      head: "bbb",
      run_at: "2026-09-06T01:00:00.000Z",
      intent_source: "pr-body",
      completeness_level: "degraded",
      unresolved_files: 1,
      completeness_notes: 1,
      radius_nodes: 2,
      radius_confirmed: 1,
      radius_partial: 1,
      findings: 1,
      findings_high: 1,
      findings_partial: 1,
      tests_selected: 0,
      coverage_gaps: 1,
      test_framework: "vitest",
    });
    expect(JSON.parse(row.raw).completeness.level).toBe("degraded");
  });

  it("carries a null pr number through", () => {
    expect(toReportRow(report(), { repo: "a/b", prNumber: null }).pr_number).toBeNull();
  });
});

describe("qualifyTable", () => {
  it("quotes a valid three-part name", () => {
    expect(qualifyTable("main", "blast_radius", "reports")).toBe("`main`.`blast_radius`.`reports`");
  });
  it("rejects anything that is not a plain identifier (injection guard)", () => {
    expect(() => qualifyTable("main", "blast_radius", "reports; drop table x")).toThrow(/invalid/);
    expect(() => qualifyTable("main", "a`b", "reports")).toThrow(/invalid/);
  });
});

describe("buildCreateSchema", () => {
  it("quotes a two-part name and guards the identifiers", () => {
    expect(buildCreateSchema("workspace", "blast_radius")).toBe(
      "CREATE SCHEMA IF NOT EXISTS `workspace`.`blast_radius`",
    );
    expect(() => buildCreateSchema("workspace", "br; drop schema x")).toThrow(/invalid/);
  });
});

describe("SQL text", () => {
  it("binds every column by name — no value is interpolated", () => {
    const fq = qualifyTable("main", "br", "reports");
    const insert = buildInsert(fq);
    expect(insert).toMatch(/^INSERT INTO `main`\.`br`\.`reports` \(/);
    expect(insert).toContain(":raw");
    expect(insert).not.toContain("'");
    expect(buildCreateTable(fq)).toContain("CREATE TABLE IF NOT EXISTS `main`.`br`.`reports`");
  });

  it("every INSERT bind has a matching parameter", () => {
    const row = toReportRow(report(), { repo: "a/b", prNumber: 1 });
    const params = toSqlParameters(row);
    const binds = [...buildInsert("`a`.`b`.`c`").matchAll(/:([a-z_]+)/g)].map((m) => m[1]);
    expect(new Set(params.map((p) => p.name))).toEqual(new Set(binds));
    expect(params.find((p) => p.name === "raw")?.type).toBe("STRING");
    expect(params.find((p) => p.name === "pr_number")?.type).toBe("INT");
  });
});

describe("exportRow", () => {
  const cfg: DatabricksConfig = {
    host: "https://example.cloud.databricks.com",
    token: "tok",
    warehouseId: "wh123",
    catalog: "main",
    schema: "blast_radius",
    table: "reports",
  };
  const ok = () =>
    new Response(JSON.stringify({ status: { state: "SUCCEEDED" } }), { status: 200 });

  it("issues CREATE SCHEMA, CREATE TABLE, then a parameterised INSERT", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const { table } = await exportRow(cfg, toReportRow(report(), { repo: "a/b", prNumber: 3 }), fetchImpl as unknown as typeof fetch);

    expect(table).toBe("`main`.`blast_radius`.`reports`");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const statements = fetchImpl.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).statement);
    expect(statements[0]).toContain("CREATE SCHEMA IF NOT EXISTS");
    expect(statements[1]).toContain("CREATE TABLE IF NOT EXISTS");
    expect(statements[2]).toContain("INSERT INTO");

    const [url, init] = fetchImpl.mock.calls[2]!;
    expect(url).toBe("https://example.cloud.databricks.com/api/2.0/sql/statements");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.warehouse_id).toBe("wh123");
    expect(sent.parameters.find((p: { name: string }) => p.name === "completeness_level").value).toBe("degraded");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("throws when a statement does not SUCCEED", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: { state: "FAILED", error: { message: "nope" } } }), { status: 200 }),
      );
    await expect(
      exportRow(cfg, toReportRow(report(), { repo: "a/b", prNumber: 1 }), fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/FAILED: nope/);
  });
});
