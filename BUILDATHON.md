# Blast Radius

> DRAFT — prepared as pre-event planning. Copy to the fork's repo root on Sep 6.
> Fill the `〔…〕` placeholders during the build: checkpoint links, the Noon
> Curveball section, and the final commit SHA.

## One-sentence summary

Blast Radius turns Entire Graph output into a single pull-request review comment
that shows the change's true dependency blast radius, flags code that drifted
from the stated intent, and recommends the minimal set of tests that actually
cover it — every claim traceable to a graph path.

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
  against "what the checkpoint says was asked". That comparison is the core of
  the product, and the intent half of it does not exist without Entire.

The brief names both directions — "impact-aware code review", "test selection
based on affected relationships", "combining graph findings with checkpoint
intent". Blast Radius is the intersection.

## Architecture and main workflow

Hexagonal (ports & adapters). The pure `domain/` core has no I/O and depends
only on four interfaces in `ports/`; every external system — the `entire-graph`
binary, git, GitHub — is an adapter; one `composition-root.ts` wires them. An
eslint boundary rule enforces the import direction at CI.

The `review` use-case is a seven-stage pipeline:

```
1  entire-graph diff            → the changed symbols (+ dependent counts)
2  entire-graph impact ×N       → each symbol's neighbourhood, folded and
                                  deduplicated into one blast radius
3–5 (pure, in parallel):
     scope check vs intent      → findings, by lexical overlap + dependents
     test selection             → proximity-ranked minimal set + run command
     radius summary             → counts by module / service / relation
6  build + validate AnalysisReport
7  render (markdown / JSON / SARIF) → publish (PR comment / file / stdout)
```

The fold (stage 2) is the core: N overlapping `impact` results merged by
`(file, symbol)`, keeping the shortest graph distance and the union of origin
symbols, so one downstream node reads "reached from A and B, nearest distance 1".

## Entire Graph findings and verification

〔During the build, record 2–3 concrete examples here. Template: 〕

- **Search:** `entire graph search --query "…"` located `〔symbol〕` at
  `〔file:line〕`, which we then read to confirm `〔…〕`.
- **Impact before a risky change:** before modifying `〔symbol〕` we ran
  `entire graph impact --symbol 〔symbol〕`. It reported `〔N〕` callers including
  `〔…〕`; we verified `〔…〕` against the source and added a test for `〔…〕`.
- **Final semantic diff:** `entire graph diff --base 〔A〕 --head 〔HEAD〕` — output
  in `blast-radius/docs/final-semantic-diff.json`. `〔M〕` entities changed;
  `〔the widest〕` had `〔K〕` dependents, which is why `〔…〕` was tested first.

Every finding in the tool's own output links to the `file:line` and the relation
path behind it — the tool practises the verifiability it asks of its users.

## Noon Curveball: what changed and how we adapted

〔Fill after 12:00. Template: 〕

**Constraint received:** 〔quote it〕

**What decision it changed:** 〔the architectural / reliability decision that
moved — not a feature that was added〕

**How the design absorbed it:** 〔which adapter / strategy / pipeline stage; why
this was a bounded change and not a rewrite — reference ARCHITECTURE.md §9〕

**Verification:** 〔the test added; what it asserts; why the revised behaviour can
be trusted. Command to run it.〕

**Checkpoint:** 〔link to Checkpoint 3〕

## Checkpoint links and what each checkpoint proves

| Checkpoint | Proves | Link |
|---|---|---|
| 1 · Initial architecture | the intended hexagonal design and pipeline were decided up front, before code | 〔link〕 |
| 2 · Last stable pre-noon | a working CLI producing a real report from graph data; documented what was done, deferred, and at risk | 〔link〕 |
| 3 · Curveball response | the constraint fully addressed as a bounded change, with a test | 〔link〕 |
| 4 · Final | all tests green including the curveball test; final semantic-diff recorded | 〔link〕 |

A fresh agent session can resume from any of these — Checkpoint 2 was used
exactly that way at noon.

## Setup, run and test instructions

```bash
cd blast-radius
npm ci
npm test            # unit + end-to-end (runs on recorded fixtures, no binary needed)
npm run build

# report from recorded Entire Graph output:
node dist/cli.js review --fixture fixtures/entire-graph --format markdown

# report from a live analysis of this repo:
go build -o /tmp/eg ../cmd/entire-graph
node dist/cli.js review --entire-graph /tmp/eg --base <BASE_SHA> --head HEAD
```

Requires Node ≥ 20. The live path also needs Go (to build `entire-graph`) — the
GitHub Action does this on the runner.

## Databricks use, data sources and limitations

Not applicable — this submission does not use Databricks.

## Known limitations and next steps

**Limitations (stated in the tool's output where relevant):**

- Static call resolution — dynamic dispatch, reflection and string-keyed
  handlers can be missed or over-approximated. `entire-graph` reports
  `completeness: degraded` when unsure; we surface the graph path so the
  reviewer verifies rather than trusts.
- `impact` is queried at depth 2 — direct callers plus one transitive hop.
- Scope overlap is lexical: "throttle" does not yet match "rate limit".
- Test "coverage" means a test *reaches* the changed symbol in the graph — it is
  test *selection*, not coverage measurement.
- The diagram in the PR comment shows the caller path only; the full node list is
  in the comment's table and the JSON output.

**Next steps toward production:**

1. Graph-anchored scope scoring — a change one hop from an in-scope symbol is
   probably legitimate collateral; downgrade it.
2. Call-site fix lists — `impact` already returns every call site; emit them as a
   checklist for signature changes.
3. An MCP tool wrapping the pure `review()` use-case, so a coding agent runs the
   analysis *before* it edits, not just a human after.
4. Replace the `.entire/intent/<id>.json` read with `entire checkpoint show` for
   the real captured session (Path B / Go subcommand).

---

_Fork: 〔URL〕 · final commit: 〔SHA〕 · Entire mirror: 〔URL〕 · Track 2 · MIT_
