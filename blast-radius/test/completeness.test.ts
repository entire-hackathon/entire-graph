import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FixtureGraphProvider } from "../src/adapters/fixture.js";
import {
  COMPLETE,
  extractCompleteness,
  worstCompleteness,
} from "../src/domain/completeness.js";
import { renderJson } from "../src/domain/render.js";
import { runReview } from "../src/review.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** A repo path that is deliberately not a git worktree, so intent falls back to the PR body. */
const nonGitRepo = () => mkdtemp(path.join(tmpdir(), "blast-radius-"));

const review = async (fixture: string, over: Partial<Parameters<typeof runReview>[1]> = {}) => {
  const repo = await nonGitRepo();
  return runReview(new FixtureGraphProvider(path.join(FIXTURES, fixture)), {
    range: { base: "aaaaaaa", head: "ccccccc" },
    repo,
    prTitle: "Rate limit the redirect endpoint",
    prBody: "Add rate limiting to the redirect endpoint so abusive clients are throttled.",
    render: { diagram: false },
    ...over,
  });
};

describe("extractCompleteness", () => {
  it("reports complete when the graph discloses no coverage problem", () => {
    expect(extractCompleteness({ stats: { completeness_level: "ok" } })).toEqual(COMPLETE);
    expect(extractCompleteness({})).toEqual(COMPLETE);
  });

  it("maps both completeness_level degraded and unsafe onto degraded", () => {
    expect(extractCompleteness({ stats: { completeness_level: "degraded" } }).level).toBe("degraded");
    expect(extractCompleteness({ stats: { completeness_level: "unsafe" } }).level).toBe("degraded");
  });

  it("a flagged file with an otherwise-ok level is partial, not degraded", () => {
    const c = extractCompleteness({
      partial_failures: [{ code: "E_MINIFIED", file_path: "dist/bundle.js" }],
    });
    expect(c.level).toBe("partial");
    expect(c.unresolvedFiles).toEqual(["dist/bundle.js"]);
  });

  it("pulls unresolved files from partial_failures and E_-coded warnings, not W_ advisories", () => {
    const c = extractCompleteness({
      stats: { completeness_level: "degraded", partial_failures: 1 },
      partial_failures: [
        { code: "E_PARSE_ERROR", file_path: "src/db/client.ts", effect_on_semantic_completeness: "undercounted" },
      ],
      warnings: [
        { code: "E_FILE_TOO_LARGE", file_path: "vendor/big.ts", effect_on_semantic_completeness: "skipped" },
        { code: "W_WORKTREE_SNAPSHOT", effect_on_semantic_completeness: "snapshot from working tree" },
      ],
    });
    expect(c.level).toBe("degraded");
    expect(c.unresolvedFiles).toEqual(["src/db/client.ts", "vendor/big.ts"]);
    expect(c.notes.some((n) => n.includes("E_PARSE_ERROR"))).toBe(true);
    expect(c.notes.some((n) => n.includes("W_WORKTREE_SNAPSHOT"))).toBe(true);
  });

  it("worstCompleteness keeps the least-complete level and unions the files", () => {
    const a = extractCompleteness({ partial_failures: [{ code: "E_X", file_path: "a.ts" }] });
    const b = extractCompleteness({ stats: { completeness_level: "unsafe" } });
    const w = worstCompleteness(COMPLETE, a, b);
    expect(w.level).toBe("degraded");
    expect(w.unresolvedFiles).toContain("a.ts");
  });
});

describe("review with incomplete graph analysis", () => {
  it("never presents a degraded analysis as complete", async () => {
    const { report, markdown } = await review("partial-analysis");

    // completeness threaded end to end
    expect(report.completeness.level).toBe("degraded");
    expect(report.completeness.unresolvedFiles).toContain("src/db/client.ts");
    expect(report.radius.completeness).toEqual(report.completeness);

    // the banner is rendered
    expect(markdown).toMatch(/Graph completeness: degraded/);
    expect(markdown).toContain("src/db/client.ts");

    // no "complete" / "every" claim survives
    expect(markdown).not.toContain("covers every changed symbol");
    expect(markdown).not.toContain("every change maps to the stated intent");
    expect(markdown).not.toContain("every row is backed by the graph path behind it");

    // the finding sits in an unresolved file → marked partial, not confirmed
    const dbFinding = report.findings.find((f) => f.symbol.qualifiedName === "DbClient.query");
    expect(dbFinding?.confidence).toBe("partial");
    expect(markdown).toContain("? unverified");

    // a per-finding verify line is present
    expect(markdown).toContain("entire graph impact --symbol DbClient.query");

    // JSON output carries completeness + per-finding confidence
    const json = JSON.parse(renderJson(report));
    expect(json.completeness.level).toBe("degraded");
    expect(json.findings[0].confidence).toBe("partial");
  });

  it("a node whose file the graph could not analyse is downgraded to partial", async () => {
    const { report } = await review("partial-analysis");
    const viaDbClient = report.radius.nodes.filter((n) =>
      n.originSymbols.includes("DbClient.query"),
    );
    expect(viaDbClient.length).toBeGreaterThan(0);
    expect(viaDbClient.every((n) => n.confidence === "partial")).toBe(true);
  });
});

describe("review against a real partial analysis (numpy diff + impact)", () => {
  // Captured from `numpy/numpy` HEAD~8..HEAD: 249 E_PARSE_ERROR across C/C++
  // headers and SIMD kernels, and an `impact` run that graded itself `degraded`.
  // Fixtures trimmed (see `_TRUNCATED_FOR_FIXTURE` markers); structure is real.
  it("carries the graph's own 'degraded' verdict all the way to the comment", async () => {
    const { report, markdown } = await review("numpy-partial", {
      prTitle: "positive ufunc: raise on boolean input",
      prBody: "Make numpy.positive reject boolean arrays instead of silently returning them.",
      maxSymbols: 400,
    });

    expect(report.completeness.level).toBe("degraded");
    expect(report.completeness.unresolvedFiles.length).toBeGreaterThan(5);
    expect(report.completeness.unresolvedFiles.some((f) => /\.(c|h|cpp|cc)$/.test(f))).toBe(true);

    expect(markdown).toMatch(/Graph completeness: degraded/);
    expect(markdown).not.toContain("covers every changed symbol");
    expect(markdown).not.toContain("every change maps to the stated intent");
    expect(markdown).not.toContain("every row is backed by the graph path behind it");

    // a degraded run stamps nothing "confirmed"
    expect(report.radius.nodes.every((n) => n.confidence === "partial")).toBe(true);
    expect(report.findings.every((f) => f.confidence === "partial")).toBe(true);

    const json = JSON.parse(renderJson(report));
    expect(json.completeness.level).toBe("degraded");
    expect(Array.isArray(json.completeness.unresolvedFiles)).toBe(true);
  });
});

describe("review with fully-resolved graph analysis (unchanged behaviour)", () => {
  it("renders the confident report with no completeness hedging", async () => {
    const { report, markdown } = await review("resolved");

    expect(report.completeness).toEqual(COMPLETE);

    // no banner, no graph badge
    expect(markdown).not.toMatch(/Graph completeness/);
    expect(markdown).not.toContain("badge/graph-");

    // the original confident phrasing is preserved
    expect(markdown).toContain("every change maps to the stated intent");
    expect(markdown).toContain("covers every changed symbol");
    expect(markdown).toContain("every row is backed by the graph path behind it");

    // structural edges from parsed files are confirmed
    const structural = report.radius.nodes.filter((n) =>
      ["CALLS", "CALLED_BY", "USES_TYPE"].includes(n.relation),
    );
    expect(structural.length).toBeGreaterThan(0);
    expect(structural.every((n) => n.confidence === "confirmed")).toBe(true);
  });
});
