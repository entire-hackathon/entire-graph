#!/usr/bin/env node
/** Blast Radius CLI — arg parsing → composition → runReview. */
import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { EntireGraphCliProvider } from "./adapters/cli.js";
import {
  databricksConfigFromEnv,
  exportRow,
  toReportRow,
} from "./adapters/databricks.js";
import { FixtureGraphProvider } from "./adapters/fixture.js";
import type { AnalysisReport } from "./domain/model.js";
import { renderJson } from "./domain/render.js";
import { runReview } from "./review.js";
import type { GraphProvider } from "./ports.js";

const program = new Command();
program.name("blast-radius").description("Impact-aware PR review powered by Entire Graph").version("0.1.0");

program
  .command("review")
  .option("--base <ref>", "base revision", "HEAD~1")
  .option("--head <ref>", "head revision", "HEAD")
  .option("--repo <path>", "repository path", ".")
  .option("--fixture <dir>", "use recorded entire graph JSON instead of the binary")
  .option("--entire-graph <cmd>", "how to invoke the graph, space-separated", "entire graph")
  .option("--profile <p>", "fast | full", "fast")
  .option("--graph-head", "query the committed tree (reuses a warm index --head cache)")
  .option("--max-symbols <n>", "cap how many changed symbols to run impact for", (v) => parseInt(v, 10))
  .option("--format <fmt>", "markdown | json", "markdown")
  .option("--out <file>", "write here instead of stdout")
  .option("--json-out <file>", "also write the JSON report here (for a Delta / warehouse export)")
  .option("--pr-title <s>", "PR title (intent fallback)")
  .option("--pr-body <s>", "PR body (intent fallback)")
  .option("--blob-url-base <url>", "https://host/owner/repo/blob/<sha> — makes symbols clickable")
  .option("--dependents-threshold <n>", "wide-reaching-change threshold", (v) => parseInt(v, 10))
  .option("--max-tests <n>", "cap the recommended test list", (v) => parseInt(v, 10))
  .option("--fail-on-findings", "exit non-zero when scope findings exist")
  .option("--quiet", "suppress progress logs")
  .action(async (opts) => {
    const log = opts.quiet ? undefined : (m: string) => process.stderr.write(`[blast-radius] ${m}\n`);

    const graph: GraphProvider = opts.fixture
      ? new FixtureGraphProvider(opts.fixture)
      : new EntireGraphCliProvider({
          argv0: String(opts.entireGraph).split(/\s+/),
          repo: opts.repo,
          profile: opts.profile === "full" ? "full" : "fast",
          head: Boolean(opts.graphHead),
        });

    try {
      const { report, markdown } = await runReview(graph, {
        range: { base: opts.base, head: opts.head },
        repo: opts.repo,
        prTitle: opts.prTitle,
        prBody: opts.prBody,
        scope: opts.dependentsThreshold ? { wideThreshold: opts.dependentsThreshold } : {},
        maxTests: opts.maxTests,
        maxSymbols: opts.maxSymbols,
        render: { repoBlobUrlBase: opts.blobUrlBase, toolUrl: "[Blast Radius](https://github.com/entire-hackathon/entire-graph/tree/main/blast-radius)" },
        log,
      });

      const body = opts.format === "json" ? renderJson(report) : markdown;
      if (opts.out) {
        await writeFile(opts.out, body, "utf8");
        log?.(`wrote ${opts.out}`);
      } else {
        process.stdout.write(body + "\n");
      }

      // one review run, both artifacts: the Markdown comment and the JSON the
      // Databricks export step lands in Delta (avoids re-running the graph).
      if (opts.jsonOut && opts.jsonOut !== opts.out) {
        await writeFile(opts.jsonOut, renderJson(report), "utf8");
        log?.(`wrote ${opts.jsonOut}`);
      }

      if (opts.failOnFindings && report.findings.length > 0) {
        process.stderr.write(`\n✖ ${report.findings.length} scope finding(s)\n`);
        process.exitCode = 1;
      }
    } catch (e) {
      process.stderr.write(`\n✖ ${(e as Error).message}\n`);
      process.exitCode = 2;
    }
  });

program
  .command("databricks-export")
  .description("append one row per review to a Delta table (SQL Statement Execution API)")
  .requiredOption("--report <file>", "a JSON report from `review --json-out`")
  .option("--repo <slug>", "owner/repo", process.env.GITHUB_REPOSITORY)
  .option("--pr <n>", "pull request number", (v) => parseInt(v, 10))
  .option("--run-at <iso>", "timestamp for the row (default: now)")
  .option("--skip-if-unconfigured", "exit 0 instead of erroring when DATABRICKS_* env is absent")
  .action(async (opts) => {
    const log = (m: string) => process.stderr.write(`[blast-radius] ${m}\n`);
    try {
      const cfg = databricksConfigFromEnv();
      if (!cfg) {
        const msg = "Databricks export not configured (need DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID)";
        if (opts.skipIfUnconfigured) {
          log(`${msg} — skipping`);
          return;
        }
        throw new Error(msg);
      }
      if (!opts.repo) throw new Error("--repo (or $GITHUB_REPOSITORY) is required");

      const report = JSON.parse(await readFile(opts.report, "utf8")) as AnalysisReport;
      const row = toReportRow(report, {
        repo: opts.repo,
        prNumber: Number.isFinite(opts.pr) && opts.pr > 0 ? opts.pr : null,
        runAt: opts.runAt,
      });
      const { table } = await exportRow(cfg, row);
      log(`inserted 1 row into ${table} (completeness: ${row.completeness_level}, ${row.findings} finding(s))`);
    } catch (e) {
      process.stderr.write(`\n✖ ${(e as Error).message}\n`);
      process.exitCode = 2;
    }
  });

program.parseAsync().catch((e) => {
  process.stderr.write(`\n✖ ${(e as Error).message}\n`);
  process.exitCode = 2;
});
