#!/usr/bin/env node
/** Blast Radius CLI — arg parsing → composition → runReview. */
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { EntireGraphCliProvider } from "./adapters/cli.js";
import { FixtureGraphProvider } from "./adapters/fixture.js";
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
  .option("--profile <p>", "fast | full", "full")
  .option("--format <fmt>", "markdown | json", "markdown")
  .option("--out <file>", "write here instead of stdout")
  .option("--pr-title <s>", "PR title (intent fallback)")
  .option("--pr-body <s>", "PR body (intent fallback)")
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
          profile: opts.profile === "fast" ? "fast" : "full",
        });

    try {
      const { report, markdown } = await runReview(graph, {
        range: { base: opts.base, head: opts.head },
        repo: opts.repo,
        prTitle: opts.prTitle,
        prBody: opts.prBody,
        scope: opts.dependentsThreshold ? { wideThreshold: opts.dependentsThreshold } : {},
        maxTests: opts.maxTests,
        log,
      });

      const body = opts.format === "json" ? renderJson(report) : markdown;
      if (opts.out) {
        await writeFile(opts.out, body, "utf8");
        log?.(`wrote ${opts.out}`);
      } else {
        process.stdout.write(body + "\n");
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

program.parseAsync().catch((e) => {
  process.stderr.write(`\n✖ ${(e as Error).message}\n`);
  process.exitCode = 2;
});
