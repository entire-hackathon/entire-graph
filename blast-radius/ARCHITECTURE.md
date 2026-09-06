# Blast Radius — architecture (intended, recorded before implementation)

Track 2 · Build with Graph Intelligence. A companion tool in this fork that
turns Entire Graph output into a reviewable decision on a pull request.

## Problem

A diff hides its consequences. A one-line change to a shared function shows one
line — not the 20 call sites it affects. CI runs everything because nothing says
which tests are relevant. And a change meant to be small quietly grows a second,
unrelated modification that nobody cross-checks against the original ask.

## What it does

On a commit range it:

1. `entire graph diff` → the changed symbols (+ dependent counts)
2. `entire graph impact` per changed symbol → each one's callers / callees /
   type consumers / data flows / co-change files / siblings
3. folds those overlapping neighbourhoods into **one deduplicated blast radius**
4. cross-checks each changed symbol against the **stated intent** (the
   `Entire-Checkpoint` trailer's prompt, or the commit message) — low lexical
   overlap + real dependents ⇒ flagged as scope drift
5. ranks the affected tests by graph distance → a minimal set
6. renders a Markdown report; every claim carries the `file:line` and the
   relation path behind it, so a reviewer verifies against source.

## Shape

- **`src/domain/`** — pure, no I/O. `model` (value objects), `graph-schema`
  (zod for raw graph JSON), `graph-mapping` (raw → domain), `blast-radius` (the
  fold), `scope-creep`, `test-select`, `render`.
- **`src/ports.ts`** — the `GraphProvider` interface (`diff`, `impact`).
- **`src/adapters/`** — `fixture` (recorded JSON, for tests + offline) and
  `cli` (shells out to the `entire graph` binary from this fork).
- **`src/review.ts`** — the use-case: wires a provider to the pipeline.
- **`src/cli.ts`** — arg parsing → review.

The port seam is what makes a Noon Curveball a bounded change: a new input =
a new provider; a new judgement = a change in `scope-creep`; a new output = a
change in `render`. See `CURVEBALL.md`.

## Why Entire is essential

The product is a *join* over things only Entire provides: the dependency
structure comes from **Entire Graph** (parsing it ourselves at review time is
the hard problem Entire already solved, locally and deterministically), and the
*intent* half of the scope check comes from **Entire Checkpoints** — the
captured prompt that produced the change. Neither half is swappable.
