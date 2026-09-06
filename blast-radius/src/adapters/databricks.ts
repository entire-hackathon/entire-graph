/**
 * Databricks export — one row per Blast Radius run into a Delta table, so the
 * reports become a queryable dataset (Genie / dashboard: "which modules attract
 * the most scope creep?", "how often is the graph degraded on our repo?").
 *
 * Uses the SQL Statement Execution API only: one `CREATE TABLE IF NOT EXISTS`,
 * then one parameterised `INSERT ... VALUES`. Every value — including the raw
 * JSON payload — is a bound parameter, so PR content never reaches the SQL text.
 * The only interpolated part is the fully-qualified table name, which comes from
 * config and is validated against `[A-Za-z0-9_]+` per segment.
 */
import type { AnalysisReport } from "../domain/model.js";

export interface ReportRowMeta {
  /** "owner/repo" */
  readonly repo: string;
  readonly prNumber: number | null;
  /** ISO timestamp for the run; defaults to now. */
  readonly runAt?: string;
}

export interface ReportRow {
  readonly repo: string;
  readonly pr_number: number | null;
  readonly base: string;
  readonly head: string;
  readonly run_at: string;
  readonly generated_at: string;
  readonly intent_source: string | null;
  readonly completeness_level: string;
  readonly unresolved_files: number;
  readonly completeness_notes: number;
  readonly radius_nodes: number;
  readonly radius_confirmed: number;
  readonly radius_partial: number;
  readonly findings: number;
  readonly findings_high: number;
  readonly findings_medium: number;
  readonly findings_low: number;
  readonly findings_partial: number;
  readonly tests_selected: number;
  readonly coverage_gaps: number;
  readonly test_framework: string;
  /** the whole `--format json` report, verbatim. */
  readonly raw: string;
}

const count = <T>(xs: readonly T[], p: (x: T) => boolean): number => xs.reduce((n, x) => n + (p(x) ? 1 : 0), 0);

/** Flatten an `AnalysisReport` into the Delta row. Pure. */
export function toReportRow(report: AnalysisReport, meta: ReportRowMeta): ReportRow {
  const f = report.findings;
  const n = report.radius.nodes;
  return {
    repo: meta.repo,
    pr_number: meta.prNumber,
    base: report.range.base,
    head: report.range.head,
    run_at: meta.runAt ?? new Date().toISOString(),
    generated_at: report.generatedAt,
    intent_source: report.intent?.source ?? null,
    completeness_level: report.completeness.level,
    unresolved_files: report.completeness.unresolvedFiles.length,
    completeness_notes: report.completeness.notes.length,
    radius_nodes: n.length,
    radius_confirmed: count(n, (x) => x.confidence === "confirmed"),
    radius_partial: count(n, (x) => x.confidence === "partial"),
    findings: f.length,
    findings_high: count(f, (x) => x.severity === "high"),
    findings_medium: count(f, (x) => x.severity === "medium"),
    findings_low: count(f, (x) => x.severity === "low"),
    findings_partial: count(f, (x) => x.confidence === "partial"),
    tests_selected: report.testPlan.selected.length,
    coverage_gaps: report.testPlan.coverageGaps.length,
    test_framework: report.testPlan.framework,
    raw: JSON.stringify(report),
  };
}

const COLUMNS: ReadonlyArray<[keyof ReportRow, "STRING" | "INT" | "BIGINT" | "TIMESTAMP"]> = [
  ["repo", "STRING"],
  ["pr_number", "INT"],
  ["base", "STRING"],
  ["head", "STRING"],
  ["run_at", "TIMESTAMP"],
  ["generated_at", "STRING"],
  ["intent_source", "STRING"],
  ["completeness_level", "STRING"],
  ["unresolved_files", "INT"],
  ["completeness_notes", "INT"],
  ["radius_nodes", "INT"],
  ["radius_confirmed", "INT"],
  ["radius_partial", "INT"],
  ["findings", "INT"],
  ["findings_high", "INT"],
  ["findings_medium", "INT"],
  ["findings_low", "INT"],
  ["findings_partial", "INT"],
  ["tests_selected", "INT"],
  ["coverage_gaps", "INT"],
  ["test_framework", "STRING"],
  ["raw", "STRING"],
];

const IDENT = /^[A-Za-z0-9_]+$/;

/** `catalog`, `schema`, `table` → a validated `` `catalog`.`schema`.`table` ``. */
export function qualifyTable(catalog: string, schema: string, table: string): string {
  for (const [k, v] of Object.entries({ catalog, schema, table })) {
    if (!IDENT.test(v)) throw new Error(`invalid Databricks ${k} identifier: ${JSON.stringify(v)}`);
  }
  return `\`${catalog}\`.\`${schema}\`.\`${table}\``;
}

export function buildCreateSchema(catalog: string, schema: string): string {
  if (!IDENT.test(catalog)) throw new Error(`invalid Databricks catalog identifier: ${JSON.stringify(catalog)}`);
  if (!IDENT.test(schema)) throw new Error(`invalid Databricks schema identifier: ${JSON.stringify(schema)}`);
  return `CREATE SCHEMA IF NOT EXISTS \`${catalog}\`.\`${schema}\``;
}

export function buildCreateTable(fqTable: string): string {
  const cols = COLUMNS.map(([name, type]) => `  ${name} ${type}`).join(",\n");
  return `CREATE TABLE IF NOT EXISTS ${fqTable} (\n${cols}\n) USING DELTA`;
}

export function buildInsert(fqTable: string): string {
  const names = COLUMNS.map(([n]) => n).join(", ");
  const binds = COLUMNS.map(([n]) => `:${n}`).join(", ");
  return `INSERT INTO ${fqTable} (${names}) VALUES (${binds})`;
}

/** SQL Statement Execution API `parameters` — every column bound by name. */
export function toSqlParameters(
  row: ReportRow,
): Array<{ name: string; value: string | null; type: string }> {
  return COLUMNS.map(([name, type]) => {
    const raw = row[name];
    return { name, value: raw === null || raw === undefined ? null : String(raw), type };
  });
}

export interface DatabricksConfig {
  readonly host: string;
  readonly token: string;
  readonly warehouseId: string;
  readonly catalog: string;
  readonly schema: string;
  readonly table: string;
}

/** Read config from the standard env vars, or `null` when the export is not configured. */
export function databricksConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DatabricksConfig | null {
  const host = env.DATABRICKS_HOST?.replace(/\/+$/, "");
  const token = env.DATABRICKS_TOKEN;
  const warehouseId = env.DATABRICKS_WAREHOUSE_ID;
  if (!host || !token || !warehouseId) return null;
  return {
    host,
    token,
    warehouseId,
    // Free Edition ships a `workspace` catalog (not `main`); override if yours differs.
    catalog: env.DATABRICKS_CATALOG || "workspace",
    schema: env.DATABRICKS_SCHEMA || "blast_radius",
    table: env.DATABRICKS_TABLE || "reports",
  };
}

type Fetch = typeof fetch;

interface StatementResponse {
  statement_id?: string;
  status?: { state?: string; error?: { message?: string } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(cfg: DatabricksConfig, path: string, init: RequestInit, fetchImpl: Fetch): Promise<StatementResponse> {
  const res = await fetchImpl(`${cfg.host}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    throw new Error(`Databricks SQL API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  return (await res.json()) as StatementResponse;
}

/**
 * Submit one statement and wait for it to finish. A cold Free Edition warehouse
 * can take ~30-60s to start, so on a wait-timeout we keep polling rather than
 * cancelling. `maxWaitMs` bounds the total wait (default 3 min).
 */
async function runStatement(
  cfg: DatabricksConfig,
  statement: string,
  parameters: ReturnType<typeof toSqlParameters> | undefined,
  fetchImpl: Fetch,
  maxWaitMs = 180_000,
): Promise<void> {
  let body = await api(
    cfg,
    "/api/2.0/sql/statements",
    {
      method: "POST",
      body: JSON.stringify({
        warehouse_id: cfg.warehouseId,
        statement,
        ...(parameters ? { parameters } : {}),
        wait_timeout: "30s",
        on_wait_timeout: "CONTINUE",
      }),
    },
    fetchImpl,
  );

  const deadline = Date.now() + maxWaitMs;
  while (body.status?.state === "PENDING" || body.status?.state === "RUNNING") {
    if (Date.now() > deadline) throw new Error(`Databricks statement still ${body.status.state} after ${maxWaitMs / 1000}s (warehouse cold?)`);
    await sleep(2_000);
    body = await api(cfg, `/api/2.0/sql/statements/${body.statement_id}`, { method: "GET" }, fetchImpl);
  }

  if (body.status?.state !== "SUCCEEDED") {
    throw new Error(`Databricks statement ${body.status?.state ?? "UNKNOWN"}: ${body.status?.error?.message ?? "no detail"}`);
  }
}

/** Ensure the table exists, then insert one row. Throws on any API/statement failure. */
export async function exportRow(
  cfg: DatabricksConfig,
  row: ReportRow,
  fetchImpl: Fetch = fetch,
): Promise<{ table: string }> {
  const fqTable = qualifyTable(cfg.catalog, cfg.schema, cfg.table);
  await runStatement(cfg, buildCreateSchema(cfg.catalog, cfg.schema), undefined, fetchImpl);
  await runStatement(cfg, buildCreateTable(fqTable), undefined, fetchImpl);
  await runStatement(cfg, buildInsert(fqTable), toSqlParameters(row), fetchImpl);
  return { table: fqTable };
}
