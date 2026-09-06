# Blast Radius → Databricks (Delta export)

Every Blast Radius run already produces a full JSON report (`review --json-out`).
This step appends **one row per run** to a Delta table so the reports become a
queryable dataset — a Genie space or a dashboard that answers questions the
single PR comment can't:

- Which modules attract the most scope-creep findings over time?
- How often does Entire Graph grade our repo `degraded`, and on which file types?
- Is our test selection getting tighter (fewer coverage gaps) release over release?

It is **analytics over a reproducible dataset**: fits Free Edition (one serverless
SQL warehouse, notebooks, dashboards, Genie), no GPU or model serving needed.

## How it works

`blast-radius databricks-export` reads a `--json-out` report and makes **two calls**
to the [SQL Statement Execution API](https://docs.databricks.com/api/workspace/statementexecution):

1. `CREATE TABLE IF NOT EXISTS <catalog>.<schema>.<table> (…) USING DELTA`
2. `INSERT INTO … VALUES (:repo, :pr_number, …, :raw)` — **every value is a bound
   parameter**, including the raw JSON payload, so nothing from a PR title/body or
   a symbol name is ever concatenated into SQL. The only interpolated text is the
   table name, validated against `^[A-Za-z0-9_]+$` per part.

No secrets live in the repo. If the `DATABRICKS_*` env vars are absent the step
logs one line and exits 0 — the review is unaffected.

## One-time setup (deployment owner)

In the **one shared Free Edition workspace**:

```sql
-- a warehouse is already provisioned on Free Edition; copy its ID from
-- SQL Warehouses → (your warehouse) → Connection details → "HTTP path"
-- (the id is the last path segment) or the warehouse list URL.

CREATE SCHEMA IF NOT EXISTS main.blast_radius;
-- the table is auto-created on first export; nothing else to do.
```

Create a **personal access token** (User Settings → Developer → Access tokens).

## GitHub configuration

Repo **Secrets** (`Settings → Secrets and variables → Actions → Secrets`):

| secret | value |
|--|--|
| `DATABRICKS_HOST` | `https://<workspace>.cloud.databricks.com` |
| `DATABRICKS_TOKEN` | the PAT |
| `DATABRICKS_WAREHOUSE_ID` | e.g. `abc123def456` |

Repo **Variables** (same page → Variables), all optional:

| variable | default |
|--|--|
| `DATABRICKS_CATALOG` | `main` |
| `DATABRICKS_SCHEMA` | `blast_radius` |
| `DATABRICKS_TABLE` | `reports` |

The `Export the report to Delta` step in `.github/workflows/blast-radius.yml`
runs only when `DATABRICKS_HOST` is set.

## Run it locally

```bash
node blast-radius/dist/cli.js review --repo . --fixture blast-radius/fixtures/numpy-partial \
  --base HEAD~1 --head HEAD --json-out /tmp/report.json --out /tmp/report.md

DATABRICKS_HOST=https://…  DATABRICKS_TOKEN=…  DATABRICKS_WAREHOUSE_ID=… \
node blast-radius/dist/cli.js databricks-export --report /tmp/report.json --repo owner/repo --pr 1
```

## Table schema

One row per review. `raw` holds the entire `--format json` report for drill-down.

| column | type | notes |
|--|--|--|
| `repo` | STRING | `owner/repo` |
| `pr_number` | INT | `NULL` for `workflow_dispatch` |
| `base`, `head` | STRING | commit range |
| `run_at` | TIMESTAMP | when the export ran |
| `generated_at` | STRING | report timestamp |
| `intent_source` | STRING | `checkpoint-trailer` / `pr-body` / `commit-message` / `NULL` |
| `completeness_level` | STRING | `complete` / `partial` / `degraded` |
| `unresolved_files` | INT | files the graph could not fully analyse |
| `completeness_notes` | INT | graph diagnostics count |
| `radius_nodes` | INT | blast-radius size |
| `radius_confirmed`, `radius_partial` | INT | node confidence split |
| `findings` | INT | scope-creep findings |
| `findings_high` / `_medium` / `_low` | INT | by severity |
| `findings_partial` | INT | findings in an unresolved file |
| `tests_selected` | INT | recommended test count |
| `coverage_gaps` | INT | changed symbols no test reaches |
| `test_framework` | STRING | `vitest` / `go` / `pytest` / `unknown` |
| `raw` | STRING | full JSON report |

## Example Genie / SQL questions

```sql
-- scope creep hotspots: which files show up most in findings?
SELECT f.value:symbol:file AS file, count(*) AS findings
FROM main.blast_radius.reports
LATERAL VARIANT_EXPLODE(parse_json(raw):findings) AS f
GROUP BY 1 ORDER BY findings DESC LIMIT 10;

-- graph health: how often is analysis degraded, by week?
SELECT date_trunc('week', run_at) AS wk,
       count(*) AS runs,
       sum(CASE WHEN completeness_level <> 'complete' THEN 1 ELSE 0 END) AS partial_or_worse
FROM main.blast_radius.reports GROUP BY 1 ORDER BY 1;

-- test-selection efficiency trend
SELECT date_trunc('week', run_at) AS wk,
       avg(tests_selected) AS avg_tests, avg(coverage_gaps) AS avg_gaps
FROM main.blast_radius.reports GROUP BY 1 ORDER BY 1;
```

Point a Genie space at `main.blast_radius.reports` with the descriptions above and
ask the questions in natural language.

## Free Edition notes

- Quota-limited: if the warehouse is unavailable, the export step fails but the
  review still posts. Re-runs are safe (append-only; de-dupe in the query with
  `QUALIFY row_number() OVER (PARTITION BY repo, head ORDER BY run_at DESC) = 1`).
- Keep a screenshot of the dashboard for judging in case the live warehouse is
  cold.
- The data is synthetic/prototype (hackathon PRs); label it as such in any demo.
