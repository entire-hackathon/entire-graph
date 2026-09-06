/**
 * Pick the smallest set of tests that exercises the change.
 *  1. every test node in the radius is a candidate
 *  2. score by proximity (closer = higher; direct caller bonus)
 *  3. greedily add until every changed callable is covered
 *  4. changed callables no test reaches = explicit coverage gaps
 *  5. synthesise the run command for the detected framework
 */
import type { BlastRadius, ChangedSymbol, SymbolRef, TestCandidate, TestPlan } from "./model.js";

function framework(ref: SymbolRef): string {
  const f = (ref.file ?? "").replace(/\\/g, "/");
  if (/_test\.go$/.test(f)) return "go";
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(f)) return "vitest";
  if (/(^|\/)test_.*\.py$|_test\.py$/.test(f)) return "pytest";
  return "unknown";
}

function isFileName(ref: SymbolRef): boolean {
  return /\.[cm]?[jt]sx?$/.test(ref.name) || /_test\.(go|py)$/.test(ref.name) || ref.name === ref.file;
}

function packageDir(file: string): string {
  const i = file.replace(/\\/g, "/").lastIndexOf("/");
  return i === -1 ? "." : file.replace(/\\/g, "/").slice(0, i);
}

function command(fw: string, selected: readonly TestCandidate[]): string | null {
  if (selected.length === 0) return null;
  const files = [...new Set(selected.map((t) => t.ref.file).filter((f): f is string => !!f))];
  const names = [
    ...new Set(selected.filter((t) => !isFileName(t.ref)).map((t) => t.ref.name)),
  ];
  switch (fw) {
    case "go": {
      const dirs = [...new Set(files.map(packageDir))].map((d) => `./${d}/...`);
      return names.length
        ? `go test -run '^(${names.join("|")})$' ${dirs.join(" ")}`
        : `go test ${dirs.join(" ")}`;
    }
    case "vitest":
      return names.length
        ? `npx vitest run ${files.join(" ")} -t "${names.join("|")}"`
        : `npx vitest run ${files.join(" ")}`;
    case "pytest":
      return `pytest ${selected.map((t) => (t.ref.file && !isFileName(t.ref) ? `${t.ref.file}::${t.ref.name}` : (t.ref.file ?? t.ref.name))).join(" ")}`;
    default:
      return null;
  }
}

const CALLABLE = new Set(["function", "method", "constructor"]);

export function selectTests(
  radius: BlastRadius,
  origin: readonly ChangedSymbol[],
  maxTests = 12,
): TestPlan {
  const testNodes = radius.nodes.filter((n) => n.isTest);
  const fw = (() => {
    const tally = new Map<string, number>();
    for (const n of testNodes) {
      const f = framework(n.ref);
      if (f !== "unknown") tally.set(f, (tally.get(f) ?? 0) + 1);
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
  })();

  const ranked = testNodes
    .map((n) => ({
      n,
      score: 1 / (1 + n.distance) + (n.section === "callers" && n.distance <= 1 ? 0.5 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  const behavioural = origin
    .filter((s) => CALLABLE.has(s.ref.kind ?? "") && s.changeType !== "added")
    .map((s) => s.ref.qualifiedName);
  const covered = new Set<string>();
  const selected: TestCandidate[] = [];
  for (const { n } of ranked) {
    if (selected.length >= maxTests) break;
    const isNew = n.originSymbols.some((s) => !covered.has(s));
    if (!isNew && selected.length > 0) continue;
    for (const s of n.originSymbols) covered.add(s);
    selected.push({ ref: n.ref, distance: n.distance, covers: [...n.originSymbols] });
  }

  return {
    framework: fw,
    selected,
    command: command(fw, selected),
    coverageGaps: behavioural.filter((s) => !covered.has(s)),
  };
}
