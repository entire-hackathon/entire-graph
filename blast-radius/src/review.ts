/**
 * The `review` use-case — the pipeline, spelled out.
 *   diff → impact per changed symbol → fold → { scope check · test selection } → report
 * Depends only on a GraphProvider + an intent resolver.
 */
import { computeBlastRadius } from "./domain/blast-radius.js";
import type { AnalysisReport } from "./domain/model.js";
import { renderMarkdown, type RenderOptions } from "./domain/render.js";
import { detectScopeCreep, type ScopeOptions } from "./domain/scope-creep.js";
import { selectTests } from "./domain/test-select.js";
import { resolveIntent, type IntentContext } from "./adapters/intent.js";
import type { CommitRange, GraphProvider } from "./ports.js";

export interface ReviewRequest {
  readonly range: CommitRange;
  readonly repo: string;
  readonly prTitle?: string | undefined;
  readonly prBody?: string | undefined;
  readonly scope?: ScopeOptions;
  readonly maxTests?: number | undefined;
  readonly render?: RenderOptions;
  readonly log?: (msg: string) => void;
}

export async function runReview(
  graph: GraphProvider,
  req: ReviewRequest,
): Promise<{ report: AnalysisReport; markdown: string }> {
  const log = req.log ?? (() => {});

  const changeSet = await graph.diff(req.range);
  log(`${changeSet.symbols.length} changed symbol(s) across ${changeSet.changedFiles.length} file(s)`);

  const impacts = await Promise.all(
    changeSet.symbols.map((s) =>
      graph.impact({ name: s.ref.qualifiedName, file: s.ref.file }).catch((e) => {
        log(`impact skipped for ${s.ref.qualifiedName}: ${(e as Error).message}`);
        return { nodes: [], disambiguation: false };
      }),
    ),
  );
  const radius = computeBlastRadius(changeSet.symbols, impacts.map((i) => i.nodes));
  log(`blast radius: ${radius.nodes.length} node(s)`);

  const intentCtx: IntentContext = {
    repo: req.repo,
    head: req.range.head,
    prTitle: req.prTitle,
    prBody: req.prBody,
  };
  const { intent, checkpoint } = await resolveIntent(intentCtx);
  log(intent ? `intent from ${intent.source}` : "no stated intent found");

  const findings = detectScopeCreep(changeSet, intent, radius, req.scope);
  const testPlan = selectTests(radius, changeSet.symbols, req.maxTests ?? 12);

  const report: AnalysisReport = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    range: { base: req.range.base, head: req.range.head, checkpoint: checkpoint ?? changeSet.checkpoint },
    intent,
    changedSymbols: changeSet.symbols,
    radius,
    findings,
    testPlan,
  };
  return { report, markdown: renderMarkdown(report, req.render ?? {}) };
}
