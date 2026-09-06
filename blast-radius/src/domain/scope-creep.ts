/**
 * Scope-creep detection. The graph says what changed; the intent says what was
 * asked. A changed symbol whose name shares no vocabulary with the intent, and
 * that other code depends on, is flagged.
 *
 * Deliberately lexical, not embeddings — it has to be explainable to a reviewer
 * in one sentence: "this symbol shares no words with the ticket."
 */
import type { BlastRadius, ChangeSet, Finding, IntentModel, Severity } from "./model.js";
import { loc } from "./model.js";

const STOP = new Set([
  "the", "and", "for", "with", "add", "adds", "added", "fix", "fixes", "update", "updates",
  "change", "changes", "make", "use", "using", "support", "new", "into", "endpoint", "so",
  "that", "this", "when", "get", "set", "run", "via", "per",
]);

export interface SplitOptions {
  /** keep tokens shorter than 3 chars (dropped by default). */
  readonly keepShort?: boolean;
}

export function splitIdent(s: string, opts: SplitOptions = {}): string[] {
  const parts = s
    .replace(/[/\\.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return opts.keepShort ? parts : parts.filter((p) => p.length >= 2);
}

function stem(w: string): string {
  return w.replace(/(ies)$/, "y").replace(/(ing|ed|ly|es|s|er|or)$/, "");
}

export function keywords(text: string, extraTerms: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const w of [...splitIdent(text), ...extraTerms]) {
    if (w.length < 3 || STOP.has(w)) continue;
    const s = stem(w);
    if (s.length >= 3 && !STOP.has(s)) out.add(s);
  }
  return [...out].sort();
}

function tokens(qualifiedName: string, file: string | undefined): Set<string> {
  const parts = [
    ...splitIdent(qualifiedName),
    ...(file ? splitIdent(file.replace(/\.[a-z0-9]+$/i, "")) : []),
  ].filter((p) => !["src", "internal", "pkg", "lib", "cmd", "test", "tests"].includes(p));
  const out = new Set<string>();
  for (const p of parts) {
    if (p.length < 3 || STOP.has(p)) continue;
    out.add(stem(p));
  }
  return out;
}

function severity(deps: number): Severity {
  if (deps >= 15) return "high";
  if (deps >= 6) return "medium";
  return "low";
}

export interface ScopeOptions {
  readonly maxOverlap?: number;
  readonly minDependents?: number;
  readonly wideThreshold?: number;
}

export function detectScopeCreep(
  changeSet: ChangeSet,
  intent: IntentModel | null,
  radius: BlastRadius,
  opts: ScopeOptions = {},
): Finding[] {
  const maxOverlap = opts.maxOverlap ?? 0.15;
  const minDeps = opts.minDependents ?? 3;
  const wide = opts.wideThreshold ?? 8;
  const kw = new Set(intent?.keywords ?? []);
  const findings: Finding[] = [];

  for (const s of changeSet.symbols) {
    if (s.changeType === "added") continue;
    const t = tokens(s.ref.qualifiedName, s.ref.file);
    const shared = [...t].filter((x) => kw.has(x));
    const overlap = t.size === 0 ? 1 : shared.length / t.size;

    const keywordMiss = kw.size > 0 && overlap <= maxOverlap && s.dependentsCount >= minDeps;
    const wideReach = s.dependentsCount >= wide;
    if (!keywordMiss && !wideReach) continue;

    const trail = radius.nodes
      .filter((n) => n.section === "callers" && n.originSymbols.includes(s.ref.qualifiedName) && !n.isTest)
      .slice(0, 3)
      .map((n) => n.ref.qualifiedName);

    const reasons: string[] = [];
    if (keywordMiss) {
      reasons.push(
        shared.length === 0
          ? "no vocabulary overlap with the stated intent"
          : `weak overlap with the stated intent (only: ${shared.join(", ")})`,
      );
    }
    if (wideReach) {
      reasons.push(
        s.changeType === "signature_changed"
          ? `signature changed with ${s.dependentsCount} dependents — run tests first`
          : `wide-reaching change: ${s.dependentsCount} dependents`,
      );
    }

    findings.push({
      symbol: s.ref,
      severity: severity(s.dependentsCount),
      reason: reasons.join("; "),
      dependentsCount: s.dependentsCount,
      evidence: [
        intent ? `intent (${intent.source}): "${intent.text.slice(0, 90)}"` : "no stated intent",
        `changed — ${s.changeType.replace("_", " ")}, ${s.dependentsCount} dependents` +
          (loc(s.ref) ? ` — ${loc(s.ref)}` : ""),
        ...(trail.length ? [`reaches ${trail.join(" → ")}`] : []),
      ],
    });
  }

  return findings.sort(
    (a, b) =>
      ({ high: 3, medium: 2, low: 1 })[b.severity] - ({ high: 3, medium: 2, low: 1 })[a.severity] ||
      b.dependentsCount - a.dependentsCount,
  );
}
