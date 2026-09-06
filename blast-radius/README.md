# 🧨 Blast Radius

Impact-aware PR review, built on Entire Graph. Folds `entire graph diff` +
`impact` into one blast radius, checks it against the stated intent (the
`Entire-Checkpoint` trailer or the commit message), and recommends a minimal
test set. Every claim is backed by the graph path behind it.

Track 2 · Build with Graph Intelligence · BTW Buildathon 2026.

## Run

```bash
cd blast-radius
npm ci
npm test
npm run build

# analyse a range with the entire graph plugin:
node dist/cli.js review --repo .. --base HEAD~2 --head HEAD

# or from recorded graph output (no plugin needed):
node dist/cli.js review --fixture fixtures/scenario --repo .. --base HEAD~2 --head HEAD

# machine-readable:
node dist/cli.js review --repo .. --base HEAD~2 --head HEAD --format json
```

## Usage

| Flag | Meaning |
|--|--|
| `--base` / `--head` | the commit range to analyse (default `HEAD~1`..`HEAD`) |
| `--repo` | repository path (default `.`) |
| `--fixture <dir>` | read recorded graph JSON instead of running the binary |
| `--entire-graph "<cmd>"` | how to invoke the graph (`"entire graph"` or a binary path) |
| `--graph-head` | query the committed tree — reuses a warm `index --head` cache |
| `--format markdown \| json` | output format |
| `--out <file>` | write to a file instead of stdout |
| `--blob-url-base <url>` | `https://host/owner/repo/blob/<sha>` — makes symbols clickable |
| `--max-tests <n>` / `--max-symbols <n>` | caps |
| `--fail-on-findings` | exit non-zero when scope findings exist |

## How it works

`src/review.ts` is the pipeline:

1. `diff` → changed symbols (+ dependent counts) — `domain/graph-mapping.ts`
2. `impact` per symbol → each neighbourhood, folded and deduplicated into one
   blast radius — `domain/blast-radius.ts`
3. scope check: lexical overlap of each changed symbol vs the intent's keywords,
   plus a dependents threshold — `domain/scope-creep.ts`
4. test selection: proximity-ranked minimal set + a run command —
   `domain/test-select.ts`
5. render Markdown / JSON — `domain/render.ts`

The `GraphProvider` port (`src/ports.ts`) has two adapters: `fixture` (recorded
JSON) and `cli` (the real `entire graph` binary). See `ARCHITECTURE.md`.
