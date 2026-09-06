/**
 * AnalysisReport → a Markdown review comment.
 *
 * Layout: a shields.io badge strip, a Mermaid graph of the change and its
 * callers (findings in red), the scope table, a copy-paste test command, then
 * collapsed detail — evidence, the test rationale, the full node list. Every
 * symbol links to `file:line` when a repo blob-url base is supplied.
 */
import type { Completeness } from "./completeness.js";
import type { AnalysisReport, Confidence, RadiusSection, SymbolRef } from "./model.js";
import { loc } from "./model.js";

export interface RenderOptions {
  /** e.g. "https://github.com/org/repo/blob/<sha>" — makes locators clickable. */
  readonly repoBlobUrlBase?: string | undefined;
  /** draw the Mermaid diagram (default true). */
  readonly diagram?: boolean;
  readonly toolUrl?: string | undefined;
}

const SEV_ICON = { high: "🔴", medium: "🟠", low: "🟡" } as const;
const SEV_COLOR = { high: "da3633", medium: "d29922", low: "bf8700" } as const;

const CONF_MARK: Record<Confidence, string> = { confirmed: "🔒", heuristic: "~", partial: "?" };
const CONF_WORD: Record<Confidence, string> = {
  confirmed: "confirmed — structural graph edge",
  heuristic: "heuristic — verify against source",
  partial: "unverified — the graph could not fully analyse this",
};
const COMPLETENESS_COLOR: Record<Completeness["level"], string> = {
  complete: "2da44e",
  partial: "d29922",
  degraded: "da3633",
};

/** The completeness banner + a collapsed list of what the graph could not analyse. */
function renderCompletenessBanner(c: Completeness): string[] {
  if (c.level === "complete") return [];
  const n = c.unresolvedFiles.length;
  const files = `${n} ${n === 1 ? "file" : "files"}`;
  const head =
    n > 0
      ? `⚠ **Graph completeness: ${c.level}** — ${files} the graph could not fully analyse; findings may be incomplete and some edges are unverified.`
      : `⚠ **Graph completeness: ${c.level}** — the graph's coverage of this range is limited; findings may be incomplete.`;
  const out = [head, ""];
  const detail: string[] = [];
  if (n > 0) {
    detail.push("**Unresolved files** (edges into or out of these may be missing):", "");
    for (const f of c.unresolvedFiles.slice(0, 12)) detail.push(`- \`${f}\``);
    if (n > 12) detail.push(`- _…and ${n - 12} more_`);
    detail.push("");
  }
  if (c.notes.length > 0) {
    detail.push("**Graph diagnostics:**", "");
    for (const note of c.notes.slice(0, 12)) detail.push(`- ${note}`);
    if (c.notes.length > 12) detail.push(`- _…and ${c.notes.length - 12} more_`);
    detail.push("");
  }
  if (detail.length > 0) {
    out.push("<details><summary>What the graph could not resolve</summary>", "", ...detail, "</details>", "");
  }
  return out;
}

function short(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

function badge(label: string, message: string, color: string): string {
  const enc = (s: string) =>
    encodeURIComponent(s.replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_"));
  return `![${label}](https://img.shields.io/badge/${enc(label)}-${enc(message)}-${color})`;
}

function moduleOf(file: string): string {
  const p = file.replace(/\\/g, "/").split("/");
  return p.slice(0, 2).join("/");
}

/** The `entire graph impact` call a reviewer can re-run to see the evidence behind a finding. */
function verifyCommand(sym: SymbolRef): string {
  const parts = ["entire graph impact --symbol", sym.qualifiedName];
  if (sym.file) parts.push("--file", sym.file.replace(/\\/g, "/"));
  return parts.join(" ");
}

/** " · then run `<cmd>`" pointing at the selected test that covers this symbol, if any. */
function coveringTestHint(r: AnalysisReport, qn: string): string {
  const t = r.testPlan.selected.find((c) => c.covers.includes(qn));
  if (!t) return " · no selected test reaches this — check manually";
  if (r.testPlan.command) return ` · then run \`${r.testPlan.command}\``;
  return ` · covered by \`${t.ref.name}\``;
}

export function renderMarkdown(report: AnalysisReport, opts: RenderOptions = {}): string {
  const r = report;
  const nodes = r.radius.nodes;
  const out: string[] = [];

  const link = (ref: Pick<SymbolRef, "file" | "line">, text: string): string => {
    if (!ref.file) return text;
    if (!opts.repoBlobUrlBase) return `${text} \`${loc(ref)}\``;
    return `[${text}](${opts.repoBlobUrlBase}/${ref.file}${ref.line ? `#L${ref.line}` : ""})`;
  };

  /* -------- summary numbers -------- */
  const files = new Set<string>();
  const modules = new Set<string>();
  const byRel: Record<string, number> = {};
  for (const n of nodes) {
    if (n.ref.file) {
      files.add(n.ref.file);
      modules.add(moduleOf(n.ref.file));
    }
    byRel[n.relation] = (byRel[n.relation] ?? 0) + 1;
  }
  const findingNames = new Set(r.findings.map((f) => f.symbol.qualifiedName));
  const maxSev = r.findings.reduce<"high" | "medium" | "low" | null>((a, f) => {
    const rank = { high: 3, medium: 2, low: 1 };
    return !a || rank[f.severity] > rank[a] ? f.severity : a;
  }, null);

  out.push("<!-- blast-radius -->");
  out.push("## 🧨 Blast Radius");
  out.push("");
  const badges = [
    badge("blast radius", `${nodes.length} nodes`, "1f6feb"),
    badge("modules", String(modules.size), "1f6feb"),
    r.findings.length === 0
      ? badge("scope", "clean", "2da44e")
      : badge("scope", `${r.findings.length} findings`, maxSev ? SEV_COLOR[maxSev] : "d29922"),
    r.testPlan.coverageGaps.length > 0
      ? badge("tests", `${r.testPlan.selected.length} · ${r.testPlan.coverageGaps.length} gaps`, "bf8700")
      : badge("tests", `${r.testPlan.selected.length} selected`, "2da44e"),
    badge("intent", r.intent ? r.intent.source : "none", r.intent ? "8250df" : "8b949e"),
    ...(r.completeness.level === "complete"
      ? []
      : [badge("graph", r.completeness.level, COMPLETENESS_COLOR[r.completeness.level])]),
  ];
  out.push(badges.join(" "));
  out.push("");

  const banner = renderCompletenessBanner(r.completeness);
  if (banner.length > 0) out.push(...banner);

  if (r.intent) {
    const line1 = r.intent.text.split("\n")[0]!.trim().slice(0, 160);
    out.push(`> **Intent** — _${JSON.stringify(line1)}_  `);
    out.push(`> source: \`${r.intent.source}\`` + (r.range.checkpoint ? ` · \`${r.range.checkpoint}\`` : ""));
  } else {
    out.push("> **Intent** — none found. Scope drift can't be judged; showing radius + tests only.");
  }
  out.push("");

  /* -------- mermaid -------- */
  const diagram = renderDiagram(r, findingNames, nodes.length);
  if (opts.diagram !== false && diagram) out.push(diagram, "");

  /* -------- scope -------- */
  if (r.findings.length > 0) {
    out.push(`### ⚠️ Scope check — ${r.findings.length} change(s) look outside the ask`);
    out.push("");
    out.push(
      "_Every scope verdict is lexical: `~` heuristic — verify against source. `?` marks a change the graph could not fully analyse, so its dependent count and reach may be wrong._",
      "",
    );
    out.push("| | Changed symbol | Why | Dependents | Confidence |");
    out.push("|--|--|--|--|--|");
    for (const f of r.findings) {
      out.push(
        `| ${SEV_ICON[f.severity]} | ${link(f.symbol, `\`${f.symbol.qualifiedName}\``)} | ${f.reason} | ${f.dependentsCount} | ${CONF_MARK[f.confidence]} ${CONF_WORD[f.confidence]} |`,
      );
    }
    out.push("");
    out.push("<details><summary>Evidence &amp; verification for these findings</summary>", "");
    for (const f of r.findings) {
      out.push(`**\`${f.symbol.qualifiedName}\`** — \`${loc(f.symbol) ?? "?"}\` · ${CONF_MARK[f.confidence]} ${CONF_WORD[f.confidence]}`);
      const seen = new Set<string>();
      for (const e of f.evidence) {
        if (seen.has(e)) continue;
        seen.add(e);
        out.push(`- ${e}`);
      }
      out.push(`- **Verify:** \`${verifyCommand(f.symbol)}\`${coveringTestHint(r, f.symbol.qualifiedName)}`);
      out.push("");
    }
    out.push("</details>", "");
  } else if (r.intent) {
    out.push(
      r.completeness.level === "complete"
        ? "### ✅ Scope check — every change maps to the stated intent"
        : `### ✅ Scope check — the changes the graph could resolve map to the stated intent _(coverage was ${r.completeness.level}; unanalysed changes are not reflected)_`,
      "",
    );
  }

  /* -------- tests -------- */
  const tp = r.testPlan;
  if (tp.selected.length > 0) {
    const resolved = r.completeness.level === "complete";
    const cover =
      tp.coverageGaps.length === 0
        ? resolved
          ? "covers every changed symbol"
          : "covers the changed symbols the graph could resolve"
        : resolved
          ? `covers all but ${tp.coverageGaps.length}`
          : `covers all but ${tp.coverageGaps.length} of the changed symbols the graph could resolve`;
    out.push(`### 🧪 Recommended tests — ${tp.selected.length}, ${cover}`, "");
    if (tp.command) out.push("```bash", tp.command, "```", "");
    out.push("<details><summary>Why these tests</summary>", "");
    out.push("| Test | Covers | Distance |", "|--|--|--|");
    for (const t of tp.selected) {
      out.push(`| ${link(t.ref, `\`${t.ref.name}\``)} | ${t.covers.map((c) => `\`${c}\``).join(", ")} | ${t.distance} |`);
    }
    if (tp.coverageGaps.length > 0) {
      out.push("", `**No test reaches:** ${tp.coverageGaps.map((g) => `\`${g}\``).join(", ")} — verify manually.`);
    }
    out.push("", "</details>", "");
  } else {
    out.push("### 🧪 Recommended tests — none found in the blast radius", "");
  }

  /* -------- full radius table -------- */
  // The confidence column only earns its space once the graph reports it is not
  // exhaustive; a fully-resolved run renders exactly as it did before.
  const showConf = r.completeness.level !== "complete";
  out.push(
    `<details><summary>Full blast radius — ${nodes.length} nodes across ${files.size} files</summary>`,
    "",
    Object.entries(byRel).sort((a, b) => b[1] - a[1]).map(([k, v]) => `\`${k}\` ${v}`).join(" · "),
    "",
    showConf ? "| Node | Relation | Dist | Confidence | From |" : "| Node | Relation | Dist | From |",
    showConf ? "|--|--|--|--|--|" : "|--|--|--|--|",
  );
  for (const n of nodes.slice(0, 60)) {
    const name = `${link(n.ref, `\`${n.ref.qualifiedName}\``)}${n.isTest ? " 🧪" : ""}`;
    const from = n.originSymbols.map((o) => `\`${o}\``).join(", ");
    out.push(
      showConf
        ? `| ${name} | \`${n.relation}\` | ${n.distance} | ${CONF_MARK[n.confidence]} | ${from} |`
        : `| ${name} | \`${n.relation}\` | ${n.distance} | ${from} |`,
    );
  }
  if (nodes.length > 60) {
    out.push(showConf ? `| _…and ${nodes.length - 60} more (\`--format json\`)_ | | | | |` : `| _…and ${nodes.length - 60} more (\`--format json\`)_ | | | |`);
  }
  if (showConf) {
    out.push(
      "",
      `<sub>🔒 confirmed — structural graph edge · \`~\` heuristic — lexical/historical, verify · \`?\` unverified — graph coverage was partial for this file</sub>`,
    );
  }
  out.push("", "</details>", "");

  out.push("---");
  const tool = opts.toolUrl ?? "Blast Radius";
  const provenance =
    r.completeness.level === "complete"
      ? "every row is backed by the graph path behind it"
      : `graph coverage was ${r.completeness.level} — 🔒 confirmed structural edges, \`~\` heuristic (verify against source), \`?\` unverified where the graph could not fully analyse the file`;
  out.push(
    `<sub>Generated by ${tool} from Entire Graph · \`${short(r.range.base)}\`..\`${short(r.range.head)}\` · ${provenance}</sub>`,
  );
  return out.join("\n");
}

/* --------------------------------------------------------------- mermaid --- */

function mermaidLabel(raw: string): string {
  return raw.replace(/"/g, "'").replace(/[[\]{}|]/g, "").slice(0, 48);
}

function renderDiagram(
  r: AnalysisReport,
  findingNames: Set<string>,
  totalNodes: number,
): string | null {
  const cap = 18;
  const changedNames = new Set(r.changedSymbols.map((c) => c.ref.qualifiedName));
  const changed = r.changedSymbols.filter((c) => {
    if (c.changeType === "added" && !r.radius.nodes.some((n) => n.originSymbols.includes(c.ref.qualifiedName))) {
      return false;
    }
    if (c.ref.kind === "class" || c.ref.kind === "interface" || c.ref.kind === "type") {
      const prefix = `${c.ref.qualifiedName}.`;
      if ([...changedNames].some((n) => n.startsWith(prefix))) return false;
    }
    return true;
  });
  if (changed.length === 0) return null;

  const callers = r.radius.nodes.filter((n) => n.section === "callers").sort((a, b) => a.distance - b.distance);
  if (callers.length === 0) return null;

  const map = new Map<string, string>();
  const id = (name: string) => {
    const e = map.get(name);
    if (e) return e;
    const g = `n${map.size}`;
    map.set(name, g);
    return g;
  };
  const has = (name: string) => map.has(name);

  const lines: string[] = ["```mermaid", "flowchart LR"];
  let count = 0;
  for (const c of changed) {
    if (count >= cap) break;
    lines.push(`  ${id(c.ref.qualifiedName)}["${mermaidLabel(c.ref.qualifiedName)}"]:::${findingNames.has(c.ref.qualifiedName) ? "finding" : "changed"}`);
    count++;
  }
  for (const e of r.radius.originEdges) {
    if (has(e.from) && has(e.to)) lines.push(`  ${id(e.from)} --> ${id(e.to)}`);
  }
  let callersShown = 0;
  const seen = new Set<string>();
  for (const n of callers) {
    if (count >= cap) break;
    const key = n.ref.qualifiedName;
    if (seen.has(key)) continue;
    const via = n.viaChain[n.viaChain.length - 1];
    const target = via && has(via) ? via : n.originSymbols[0];
    if (!target || !has(target)) continue;
    seen.add(key);
    if (!has(key)) {
      lines.push(`  ${id(key)}["${mermaidLabel(key)}"]:::${n.isTest ? "test" : "caller"}`);
      count++;
    }
    lines.push(`  ${id(key)} --> ${id(target)}`);
    callersShown++;
  }
  lines.push(
    "  classDef finding fill:#ffdcdc,stroke:#e5534b,color:#86181d;",
    "  classDef changed fill:#fff3d4,stroke:#d4a72c,color:#7a5c00;",
    "  classDef caller fill:#eef2f6,stroke:#8c959f,color:#1f2328;",
    "  classDef test fill:#e6f4ea,stroke:#4c9a5f,color:#1a4d2e;",
    "```",
  );
  const body = lines.join("\n");
  const legend = [
    body.includes(":::finding") ? "🟥 changed — flagged, outside the stated intent" : "",
    body.includes(":::changed") ? "🟨 changed — in scope" : "",
    body.includes(":::caller") ? "⬜ not changed — calls the change, may be affected" : "",
    body.includes(":::test") ? "🟩 not changed — a covering test" : "",
  ].filter(Boolean);
  const note = `call paths only — ${changed.length} changed symbol(s) + ${callersShown} of the ${totalNodes}-node blast radius. Callees, types, co-change files &amp; siblings are in the “Full blast radius” table below.`;
  return `${body}\n<sub>${legend.join("  ·  ")}<br>arrow: A → B means A calls B · ${note}</sub>`;
}

export function renderJson(r: AnalysisReport): string {
  return JSON.stringify(r, null, 2);
}
