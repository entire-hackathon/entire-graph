# Blast Radius

## One-sentence summary

Blast Radius turns Entire Graph output into a single pull-request review comment
that shows the change's true dependency blast radius, flags code that drifted
from the stated intent, and recommends the minimal set of tests that actually
cover it — every claim graded by how much the graph itself can back it up.

## Problem, intended user and why it matters

**User:** the engineer reviewing a pull request, and the CI system deciding what
to run.

**Problem:** a diff hides its own consequences. A one-line change to a shared
function still shows one line, so the reviewer approves without seeing the twenty
call sites it affects. CI runs the whole suite because nothing tells it which
tests are relevant. And a change that was meant to be small quietly grows a
second, unrelated modification that no one cross-checks against the original ask.

**Why it matters:** these are the three failure modes behind most "how did that
get merged" incidents. Each is invisible in the diff and visible in the graph.

## Selected Entire track and why Entire is essential

**Track 2 — Build with Graph Intelligence.**

Entire is not a data source we could swap out. The product is a *join* over
things only Entire provides:

- **Entire Graph** supplies the dependency structure — `diff` for the changed
  symbols and their dependent counts, `impact` for each symbol's callers,
  callees, type consumers, data flows, co-change files and siblings. Without a
  precomputed, tree-sitter-accurate graph there is no blast radius to compute;
  parsing it ourselves at review time is the whole hard problem Entire already
  solved, locally and deterministically.
- **Entire Checkpoints** supply the *intent* — the captured prompt that produced
  the change. The scope-drift check compares "what the graph says changed"
  against "what the checkpoint says was asked". `src/adapters/intent.ts` reads
  the `Entire-Checkpoint` trailer across `base..head` and falls back to the PR
  body / commit message.

The brief names both directions — "impact-aware code review", "test selection
based on affected relationships", "combining graph findings with checkpoint
intent". Blast Radius is the intersection.

## Architecture and main workflow

Ports & adapters. The pure `src/domain/` core has no I/O; the one seam is the
`GraphProvider` port (`src/ports.ts`), with two adapters — `fixture` (recorded
JSON, used by every test) and `cli` (the real `entire graph` binary). `review.ts`
wires a provider to the pipeline; `cli.ts` is arg-parsing only.

The `review` use-case:

```
1  entire graph diff            → changed symbols (+ dependent counts) + the
                                  graph's coverage self-report
2  entire graph impact ×N       → each symbol's neighbourhood, folded and
                                  deduplicated into one blast radius, worst-of
                                  the per-query completeness carried forward
3–5 (pure):
     scope check vs intent      → findings, by lexical overlap + dependents
     test selection             → proximity-ranked minimal set + run command
     confidence grading         → every node/finding: confirmed | heuristic | partial
6  build AnalysisReport (carries `completeness`)
7  render markdown / JSON       → PR comment (+ optional Delta export)
```

The fold (stage 2) is the core: N overlapping `impact` results merged by
`(file, symbol)`, keeping the shortest graph distance and the union of origin
symbols.

## Entire Graph findings and verification

- **Impact before the curveball change.** Before threading a new value through
  the domain we ran `entire graph impact` on each graph-consuming function —
  `toChangeSet`, `toRadiusNodes`, `computeBlastRadius`, `detectScopeCreep`,
  `renderMarkdown`. `computeBlastRadius` reported 3 callers (`runReview`, its
  test, `cli.ts` via `runReview`), 6 type consumers and 5 co-change files;
  `detectScopeCreep` reported 10 type consumers including `IntentModel` and
  `Finding`. That told us the blast radius of the change was the whole `domain/`
  plus both adapters plus `review` + `cli` — so the edit touched 22 files but
  each one minimally, and every new parameter got a safe default.
- **The curveball fixture is real graph output.**
  `entire graph diff --repo <numpy> --base HEAD~8 --head HEAD` on `numpy/numpy`
  returned 249 `E_PARSE_ERROR` warnings across C/C++ headers and SIMD kernels;
  `entire graph impact --symbol TestPositive.test_valid` graded *itself*
  `completeness_level: "degraded"` with 323 `partial_failures`. That output is
  committed verbatim (trimmed, with `_TRUNCATED_FOR_FIXTURE` markers) as
  `blast-radius/fixtures/numpy-partial/` and drives the new test.
- **Final semantic diff:** `entire graph diff --base 03bd0208 --head HEAD` —
  output in `blast-radius/docs/final-semantic-diff.json`. 28 files, 57 symbol
  changes; the widest was the `GraphProvider.impact` port signature (41
  dependents), which is why it is exercised through both the `cli` and `fixture`
  adapters.

Every finding in the tool's own output links to the `file:line` and the relation
path behind it, and is marked 🔒 confirmed / `~` heuristic / `?` unverified — the
tool practises the verifiability it asks of its users.

## Noon Curveball: what changed and how we adapted

**Constraint received:** *"Graph is evidence, not an oracle."* Blast Radius
treated every graph edge as ground truth and presented "N nodes, M findings,
covers every changed symbol" as authoritative — even though `entire graph` itself
reports `stats.completeness_level`, `partial_failures[]` and `warnings[]`, which
we parsed through and ignored. Requirement: distinguish confirmed structural
evidence · heuristic/incomplete evidence · claims needing verification; flag when
analysis is partial; never present incomplete context as complete.

**What decision it changed:** the tool's *trust model*, not a feature. The report
went from asserting completeness to stating what the graph can back up versus
what it is guessing.

**How the design absorbed it (bounded, not a rewrite):**

- new `src/domain/completeness.ts` — a `Completeness { level: complete | partial
  | degraded, unresolvedFiles, notes }` extracted from a raw diff/impact result;
- threaded as an *additive* field on `ChangeSet`, `BlastRadius` (worst-of the
  diff and every per-symbol `impact`) and `AnalysisReport`;
- per-node / per-finding `confidence`: a structural edge (`CALLS` / `USES_TYPE` …)
  from a parsed file → `confirmed`; the lexical scope-creep verdict → `heuristic
  — verify against source`; anything touching an unresolved file or a degraded
  run → `partial`;
- `render.ts` grew a completeness banner, per-finding markers, a `Verify:` line
  (`entire graph impact` + the covering test), and drops every "covers every /
  maps to" claim when coverage is not `complete`;
- the `GraphProvider.impact` return type gained one field.

No pipeline stage was rewritten. Every new parameter defaults to `COMPLETE`, so
the 12 pre-existing tests pass unchanged.

**Verification:** `blast-radius/test/completeness.test.ts` — the real numpy
`degraded` fixture and a synthetic rate-limit scenario assert the banner renders,
no "complete / every" claim survives, and a finding in an unresolved file is
marked `partial`; a fully-resolved fixture pins the unchanged path.
`cd blast-radius && npm test` → 30 passing.

**Checkpoint:** `2a24363c61bd` (commit `bd412e91`).

## Checkpoint links and what each checkpoint proves

| Checkpoint | Proves | Ref |
|---|---|---|
| 1 · Working core | diff+impact fold, scope-creep check, test selection, markdown/JSON report | `329f4fe4` |
| 2 · Last stable pre-noon | rich PR comment + CI posting on real graph data; `--profile full` fix | `58212b78a6b8` · commit `03bd0208` |
| 3 · Curveball response | "graph is evidence, not an oracle" fully addressed as a bounded change, with a test on real numpy output | `2a24363c61bd` · commit `bd412e91` |
| 4 · Final | Databricks Delta export added; all tests green; final semantic diff recorded | `3d2232e8a679` · commit `cbf859d2` |

A fresh agent session reconstructed the work from Checkpoint 2 at noon before the
curveball, exactly as intended.

## Setup, run and test instructions

```bash
cd blast-radius
npm ci
npm test            # 30 tests — unit + end-to-end on recorded fixtures, no binary needed
npm run build

# report from recorded Entire Graph output:
node dist/cli.js review --fixture fixtures/scenario --repo .. --base HEAD~2 --head HEAD

# the curveball case — a real degraded numpy analysis:
node dist/cli.js review --fixture fixtures/numpy-partial --repo . \
  --base HEAD~1 --head HEAD --max-symbols 400 \
  --pr-body "Make numpy.positive reject boolean arrays instead of returning them."

# report from a live analysis of this repo:
go build -o /tmp/eg ../cmd/entire-graph
node dist/cli.js review --entire-graph /tmp/eg --base <BASE_SHA> --head HEAD
```

Requires Node ≥ 20. The live path also needs Go (to build `entire-graph`) — the
GitHub Action (`.github/workflows/blast-radius.yml`) does this on the runner and
posts one comment per PR.

## Databricks use, data sources and limitations

**Award category: Best Use of Databricks.**

Every Blast Radius run emits a full JSON report (`review --json-out`).
`blast-radius databricks-export` flattens it to **one row** — completeness level,
unresolved-file count, node/finding confidence split, findings by severity, test
selection vs coverage gaps, intent source — plus the raw JSON, and appends it to
a Delta table (`workspace.blast_radius.reports`) via the **SQL Statement
Execution API**. `CREATE SCHEMA IF NOT EXISTS` → `CREATE TABLE IF NOT EXISTS` →
`INSERT … VALUES (:col, …)` with **every value bound as a named parameter**,
including the raw payload — PR titles and symbol names never reach the SQL text;
only the catalog/schema/table identifiers are interpolated, each validated
`^[A-Za-z0-9_]+$`.

That turns a stream of one-off PR comments into a **queryable dataset** for a
Genie space / dashboard:

- scope-creep hotspots — which files recur in findings;
- graph health — how often Entire Graph grades our repo `degraded`, by week and
  file type (a metric the curveball work created);
- test-selection efficiency — `tests_selected` vs `coverage_gaps` over time.

Setup, table schema and example Genie/SQL queries: `blast-radius/docs/databricks.md`.
The GitHub Action runs the export only when `DATABRICKS_HOST` is set, so the core
review is unaffected without it. Tested end-to-end against a Free Edition
workspace (`workspace` catalog, serverless 2X-Small warehouse).

**Data sources:** the tool's own review output — synthetic/prototype PRs (numpy
fixtures and this fork's own history). No customer or confidential data. No
tokens in the repo, workflow, screenshots or this file.

**Limitations:** Free Edition serverless warehouse auto-stops; the first
statement after idle waits for a cold start (the client polls the statement up to
3 minutes). The table is append-only — dedupe re-runs in the query with
`QUALIFY row_number() OVER (PARTITION BY repo, head ORDER BY run_at DESC) = 1`.
One workspace / one metastore.

## Known limitations and next steps

**Limitations (surfaced in the tool's own output):**

- Static call resolution — dynamic dispatch, reflection and string-keyed handlers
  can be missed or over-approximated. The tool now reads Entire Graph's
  `completeness_level` / `partial_failures` and marks affected evidence `partial`
  rather than trusting it.
- `impact` is queried at depth 2 — direct callers plus one transitive hop.
- Scope overlap is lexical: "throttle" does not yet match "rate limit"; the
  verdict is always labelled `heuristic — verify against source`.
- Test "coverage" means a test *reaches* the changed symbol in the graph — it is
  test *selection*, not coverage measurement.

**Next steps:**

1. Graph-anchored scope scoring — a change one hop from an in-scope symbol is
   probably legitimate collateral; downgrade it.
2. Call-site fix lists for signature changes — `impact` already returns them.
3. An MCP tool wrapping the pure `review()` use-case, so a coding agent runs the
   analysis *before* it edits.
4. A Databricks App front-end over `workspace.blast_radius.reports` for the
   reviewer-facing drill-down.

---

_Fork: https://github.com/entire-hackathon/entire-graph · branch `build/blast-radius` · final commit: see `git rev-parse HEAD` · Track 2 · MIT_
