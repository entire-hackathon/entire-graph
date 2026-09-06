# Blast Radius — Documentation

Impact-aware pull-request review, built on [Entire Graph](https://entire.io).
Folds `entire graph diff` + `impact` into one review comment that answers three
questions a diff can't:

1. **What does this change actually touch?** — the full dependency blast radius,
   not the lines in the patch.
2. **Did it stay in scope?** — each changed symbol cross-checked against the
   stated intent (the `Entire-Checkpoint` prompt, or the PR body).
3. **Which tests actually cover it?** — a proximity-ranked minimal set with a
   ready-to-run command, instead of "run everything".

Every claim in the output is graded by how much the graph can back it up:
🔒 confirmed · `~` heuristic · `?` unverified.

---

## Table of contents

- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [How it works](#how-it-works)
- [Graph is evidence, not an oracle](#graph-is-evidence-not-an-oracle)
- [Anatomy of the review comment](#anatomy-of-the-review-comment)
- [Scope-creep detection](#scope-creep-detection)
- [Test selection](#test-selection)
- [Intent resolution](#intent-resolution)
- [Databricks (Delta export)](#databricks-delta-export)
- [CI setup](#ci-setup)
- [Architecture](#architecture)
- [Fixtures](#fixtures)
- [Limitations](#limitations)

---

## Quick start

```bash
cd blast-radius
npm ci
npm test              # 30 tests, runs entirely on recorded fixtures — no binary needed
npm run build
```

Run a review from **recorded graph output** (no `entire` binary required):

```bash
node dist/cli.js review --fixture fixtures/scenario --repo .. --base HEAD~2 --head HEAD
```

Run a review against a **live analysis** of a repo:

```bash
# needs the entire-graph binary (Go + CGO to build it)
go build -o /tmp/eg ../cmd/entire-graph
node dist/cli.js review --entire-graph /tmp/eg --repo . --base HEAD~5 --head HEAD
```

Machine-readable output:

```bash
node dist/cli.js review --fixture fixtures/scenario --repo .. --format json
```

Requires Node ≥ 20.

---

## CLI reference

### `blast-radius review`

| Flag | Meaning | Default |
|---|---|---|
| `--base <ref>` / `--head <ref>` | commit range to analyse | `HEAD~1` / `HEAD` |
| `--repo <path>` | repository path | `.` |
| `--fixture <dir>` | read recorded graph JSON from `<dir>` instead of running the binary | — |
| `--entire-graph "<cmd>"` | how to invoke the graph — `"entire graph"` or a binary path | `entire graph` |
| `--profile <fast\|full>` | graph resolution profile (`full` = call-graph expansion) | `fast` |
| `--graph-head` | query the committed tree — reuses a warm `index --head` cache (much faster in CI) | off |
| `--max-symbols <n>` | cap how many changed symbols get an `impact` query (widest-reaching first) | 25 |
| `--max-tests <n>` | cap the recommended test list | 12 |
| `--dependents-threshold <n>` | "wide-reaching change" threshold for a finding | 8 |
| `--pr-title <s>` / `--pr-body <s>` | intent fallback when there's no checkpoint trailer | — |
| `--blob-url-base <url>` | `https://host/owner/repo/blob/<sha>` — makes every symbol a clickable link | — |
| `--format <markdown\|json>` | primary output format | `markdown` |
| `--out <file>` | write the primary output to a file instead of stdout | — |
| `--json-out <file>` | **also** write the JSON report here (single review run, for the Delta export) | — |
| `--fail-on-findings` | exit non-zero when scope findings exist | off |
| `--quiet` | suppress progress logs on stderr | off |

### `blast-radius databricks-export`

Appends one row per review to a Delta table. See [Databricks](#databricks-delta-export).

| Flag | Meaning |
|---|---|
| `--report <file>` | a JSON report from `review --json-out` (required) |
| `--repo <slug>` | `owner/repo` (defaults to `$GITHUB_REPOSITORY`) |
| `--pr <n>` | pull-request number (`NULL` in the row if absent or ≤ 0) |
| `--run-at <iso>` | timestamp for the row (default: now) |
| `--skip-if-unconfigured` | exit 0 instead of erroring when `DATABRICKS_*` env is absent |

Reads `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID`, and
optionally `DATABRICKS_CATALOG` (default `workspace`), `DATABRICKS_SCHEMA`
(default `blast_radius`), `DATABRICKS_TABLE` (default `reports`).

---

## How it works

`src/review.ts` is a pipeline:

```
1  diff        entire graph diff --base --head --json
                 → changed symbols (+ dependent counts), changed files,
                   and the graph's coverage self-report
2  impact      for each changed symbol (widest-reaching first, capped):
                 entire graph impact --symbol X --depth 2
                 → callers / callees / type consumers / data flows /
                   co-change files / siblings
   fold        merge the N impact results by (file, qualifiedName):
                 keep the shortest graph distance, union the origin symbols,
                 drop nodes that are themselves changed symbols (they're the
                 origin, not the blast), drop external callees as noise
3  intent      resolve the stated intent (checkpoint trailer → PR body → commit)
4  scope       lexical overlap of each changed symbol vs the intent keywords,
               plus a dependents threshold → findings
5  tests       every test node in the radius, ranked by proximity, greedily
               selected until every changed callable is covered → minimal set
6  grade       every node & finding tagged confirmed / heuristic / partial
7  render      markdown comment + JSON report
```

**The fold** is the core idea: a one-line change to `Database.query` produces one
line in the diff but, after `impact`, a blast radius of every call site, type
consumer and downstream service — deduplicated, with the shortest path to each.

---

## Graph is evidence, not an oracle

`entire graph` reports its own coverage on every result —
`stats.completeness_level` (`ok` / `degraded` / `unsafe`), `partial_failures[]`
(files it tried and failed to parse) and `warnings[]`. Blast Radius reads all of
it (`src/domain/completeness.ts`) instead of trusting the graph blindly.

### The `Completeness` value

```ts
{ level: "complete" | "partial" | "degraded",
  unresolvedFiles: string[],   // files the graph could not fully analyse
  notes: string[] }            // every diagnostic the graph disclosed
```

| graph says | Blast Radius level | meaning |
|---|---|---|
| `completeness_level: ok`, no failures | `complete` | trust the structural edges |
| a specific file failed to parse (`E_PARSE_ERROR`, `E_FILE_TOO_LARGE`, `E_MINIFIED`, `E_FILE_READ`), level otherwise ok | `partial` | the shape is intact; only evidence touching those files is suspect |
| `completeness_level: degraded` or `unsafe` | `degraded` | enough is missing that the shape itself is unreliable — nothing is "confirmed" |

`*UNSUPPORTED*` codes ("no parser for this language") and `W_`-coded warnings are
advisory — recorded in `notes`, but they don't mark a file unresolved or move
the level.

The report's completeness is the **worst of** the `diff`'s coverage and every
per-symbol `impact` query's coverage.

### Confidence, per node and per finding

| grade | shown | when |
|---|---|---|
| `confirmed` | 🔒 | a structural edge (`CALLS`, `CALLED_BY`, `USES_TYPE`, `PARAM_TYPE`, `RETURNS_TYPE`) from a fully-parsed file, on a `complete` run |
| `heuristic` | `~` | the scope-creep verdict (it's lexical — always this), and lexical/historical edges (co-change, data-flow, siblings) |
| `partial` | `?` | anything touching an unresolved file, or **any** node on a `degraded` run |

### What the reviewer sees

On a `partial` or `degraded` run the comment leads with:

> ⚠ **Graph completeness: degraded** — 68 files the graph could not fully
> analyse; findings may be incomplete and some edges are unverified.

…a collapsible list of the unresolved files and graph diagnostics, per-finding
`🔒 / ~ / ?` markers, a per-finding `Verify:` line (`entire graph impact
--symbol X` + the covering test), and the phrase *"covers every changed symbol"*
becomes *"covers the changed symbols the graph could resolve"*. A fully-resolved
run renders exactly as before — no banner, no hedging.

---

## Anatomy of the review comment

```
🧨 Blast Radius
[badges]  blast radius · modules · scope · tests · intent · (graph, if not complete)

⚠ completeness banner        ← only when level ≠ complete
> Intent — "<first line>"      source: checkpoint-trailer | pr-body | commit-message

```mermaid  flowchart          ← changed symbols + caller paths, findings in red

### ⚠️ Scope check — N changes look outside the ask
| sev | symbol | why | dependents | confidence |
<details> evidence + Verify: line per finding </details>

### 🧪 Recommended tests — K, covers …
```bash <run command> ```
<details> per-test: what it covers, graph distance </details>

<details> Full blast radius — every node, relation, distance, (confidence) </details>
```

---

## Scope-creep detection

`src/domain/scope-creep.ts`. Deliberately **lexical, not embeddings** — it has to
be explainable to a reviewer in one sentence.

1. Tokenise the intent into stemmed keywords (`"Add rate limiting to the redirect
   endpoint"` → `{rate, limit, redirect}`; stopwords and short tokens dropped).
2. For each **changed** symbol (skip additions), tokenise its qualified name +
   file path the same way.
3. Flag it when **either**:
   - **keyword miss** — vocabulary overlap ≤ 15% *and* ≥ 3 dependents, or
   - **wide reach** — ≥ 8 dependents (a signature change with that many
     dependents says "run tests first" regardless of intent).
4. Severity by dependent count: ≥ 15 high, ≥ 6 medium, else low.
5. Every finding carries the graph path it reaches (`reaches UserRepo.find → …`)
   and is labelled `heuristic — verify against source` (or `partial` if its file
   is unresolved).

Thresholds are tunable: `--dependents-threshold`, and `ScopeOptions` in code
(`maxOverlap`, `minDependents`, `wideThreshold`).

---

## Test selection

`src/domain/test-select.ts`.

1. Every test node in the blast radius is a candidate (detected by file pattern
   or `Test*` / `test_*` / `*_test` naming).
2. Score by proximity: `1 / (1 + distance)`, plus a bonus for a direct caller.
3. Greedily add the highest-scoring test that covers a not-yet-covered changed
   callable, until all are covered or `--max-tests` is hit.
4. Changed callables that **no** test reaches are reported as explicit coverage
   gaps.
5. Synthesise the run command for the detected framework (`vitest` / `go` /
   `pytest`).

This is test **selection** — a test "covers" a symbol if it *reaches* it in the
graph, not a coverage measurement.

---

## Intent resolution

`src/adapters/intent.ts`, in priority order:

1. **`Entire-Checkpoint:` trailer** on the head commit (or the newest commit in
   `base..head` that has one) → its captured prompt from
   `.entire/intent/<id>.json`, else the commit body with the trailer stripped.
   Source label: `checkpoint-trailer`.
2. **PR title + body** (`--pr-title` / `--pr-body`). Source: `pr-body`.
3. **Commit subject**. Source: `commit-message`.

With no intent at all, the scope check is skipped and the comment says so — the
radius and tests still render.

---

## Databricks (Delta export)

Turns the stream of one-off PR comments into a queryable dataset. Full setup,
table schema and example Genie/SQL queries: **[`blast-radius/docs/databricks.md`](blast-radius/docs/databricks.md)**.

In short:

```bash
node dist/cli.js review … --json-out report.json      # one review run, JSON + markdown
node dist/cli.js databricks-export --report report.json --repo owner/repo --pr 42
```

- Two SQL Statement Execution API calls: `CREATE SCHEMA IF NOT EXISTS`,
  `CREATE TABLE IF NOT EXISTS`, then `INSERT … VALUES (:col, …)` with **every
  value bound as a named parameter** — including the raw JSON payload. Only the
  catalog/schema/table names are interpolated, each validated `^[A-Za-z0-9_]+$`.
- The table (`workspace.blast_radius.reports`) has one row per review: the range,
  intent source, `completeness_level`, unresolved-file count, node confidence
  split, findings by severity, tests selected vs coverage gaps, and the full
  `raw` JSON for drill-down.
- A cold Free Edition warehouse can take ~30-60s to start; the client polls the
  statement up to 3 minutes.
- Table is append-only — dedupe re-runs in the query:
  `QUALIFY row_number() OVER (PARTITION BY repo, head ORDER BY run_at DESC) = 1`.

Example questions for a Genie space pointed at the table:

- *Which files show up most often in scope-creep findings?*
- *How often is our graph analysis `degraded`, by week?*
- *Is test selection getting tighter (fewer coverage gaps) over time?*

---

## CI setup

`.github/workflows/blast-radius.yml` runs on every `pull_request`:

1. build `entire-graph` (cached by `go.sum` + source hash),
2. build the Blast Radius CLI,
3. `review --graph-head --profile full` → `blast-radius.md` + `blast-radius.json`,
4. **Export the report to Delta** — only if `DATABRICKS_HOST` is set,
5. upsert one PR comment (edits its own previous comment).

To enable the Delta export, add repo **Secrets** `DATABRICKS_HOST`,
`DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID` (and optionally repo **Variables**
`DATABRICKS_CATALOG` / `_SCHEMA` / `_TABLE`). Absent → the step is skipped and
the review is unaffected.

---

## Architecture

Ports & adapters. The pure `src/domain/` core has no I/O.

```
src/
  domain/                  pure, no I/O
    model.ts               value objects (SymbolRef, ChangeSet, BlastRadius, Finding, …)
    graph-schema.ts        zod schemas for raw `entire graph` JSON (lenient, additive)
    completeness.ts        the coverage self-report → a Completeness value
    graph-mapping.ts       raw JSON → domain objects
    blast-radius.ts        the fold + confidence grading
    scope-creep.ts         lexical intent check
    test-select.ts         minimal covering test set
    render.ts              AnalysisReport → markdown / JSON
  ports.ts                 GraphProvider — the one seam (diff, impact)
  adapters/
    cli.ts                 EntireGraphCliProvider — shells out to the binary
    fixture.ts             FixtureGraphProvider — recorded JSON (every test uses this)
    intent.ts              checkpoint trailer / PR body / commit message
    databricks.ts          flatten a report → one Delta row via the SQL API
  review.ts                the pipeline
  cli.ts                   arg parsing → review / databricks-export
```

The `GraphProvider` port is what makes a change bounded: a new input = a new
provider; a new judgement = a change in `scope-creep`; a new output = a change in
`render`.

---

## Fixtures

`blast-radius/fixtures/` — recorded `entire graph` JSON, one directory per
scenario (`diff.json` + `impact-<symbol>.json` files):

| dir | what it is |
|---|---|
| `scenario` | this fork's own `AnalyzeGitRangeWithOptions` change — a real multi-file Go diff |
| `demo` | a small synthetic TypeScript service |
| `numpy-partial` | **real** `numpy/numpy HEAD~8..HEAD` — 249 `E_PARSE_ERROR`, `impact` self-graded `degraded`. Arrays trimmed with `_TRUNCATED_FOR_FIXTURE` markers; structure is genuine |
| `partial-analysis` | synthetic rate-limit scenario with one unresolved file — tight assertions for the completeness path |
| `resolved` | fully-clean scenario — pins the "renders exactly as before" behaviour |

---

## Limitations

- **Static call resolution.** Dynamic dispatch, reflection and string-keyed
  handlers can be missed or over-approximated. The tool reads Entire Graph's
  `completeness_level` / `partial_failures` and marks affected evidence `partial`
  rather than trusting it — but a `complete` grade is still only as good as
  tree-sitter's view of the code.
- `impact` runs at **depth 2** — direct callers plus one transitive hop.
- Scope overlap is **lexical** — "throttle" doesn't match "rate limit" yet. The
  verdict is always labelled `heuristic — verify against source`.
- Test "coverage" = the test **reaches** the changed symbol in the graph. It is
  selection, not measurement.
- The Mermaid diagram shows the **caller path only**; the full node list is in
  the comment's table and the JSON.
- Databricks export: Free Edition is quota-limited and append-only (see above).

---

_Track 2 · Build with Graph Intelligence · MIT_
