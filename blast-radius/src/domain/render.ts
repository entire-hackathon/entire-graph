/**
 * AnalysisReport → a Markdown review comment.
 *
 * Layout: a shields.io badge strip, a Mermaid graph of the change and its
 * callers (findings in red), the scope table, a copy-paste test command, then
 * collapsed detail — evidence, the test rationale, the full node list. Every
 * symbol links to `file:line` when a repo blob-url base is supplied.
 */
import type { AnalysisReport, RadiusSection, SymbolRef } from "./model.js";
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
  ];
  out.push(badges.join(" "));
  out.push("");

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
    out.push("| | Changed symbol | Why | Dependents |");
    out.push("|--|--|--|--|");
    for (const f of r.findings) {
      out.push(`| ${SEV_ICON[f.severity]} | ${link(f.symbol, `\`${f.symbol.qualifiedName}\``)} | ${f.reason} | ${f.dependentsCount} |`);
    }
    out.push("");
    out.push("<details><summary>Evidence for these findings</summary>", "");
    for (const f of r.findings) {
      out.push(`**\`${f.symbol.qualifiedName}\`** — \`${loc(f.symbol) ?? "?"}\``);
      const seen = new Set<string>();
      for (const e of f.evidence) {
        if (seen.has(e)) continue;
        seen.add(e);
        out.push(`- ${e}`);
      }
      out.push("");
    }
    out.push("</details>", "");
  } else if (r.intent) {
    out.push("### ✅ Scope check — every change maps to the stated intent", "");
  }

  /* -------- tests -------- */
  const tp = r.testPlan;
  if (tp.selected.length > 0) {
    const cover = tp.coverageGaps.length === 0 ? "covers every changed symbol" : `covers all but ${tp.coverageGaps.length}`;
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
  out.push(
    `<details><summary>Full blast radius — ${nodes.length} nodes across ${files.size} files</summary>`,
    "",
    Object.entries(byRel).sort((a, b) => b[1] - a[1]).map(([k, v]) => `\`${k}\` ${v}`).join(" · "),
    "",
    "| Node | Relation | Dist | From |",
    "|--|--|--|--|",
  );
  for (const n of nodes.slice(0, 60)) {
    out.push(`| ${link(n.ref, `\`${n.ref.qualifiedName}\``)}${n.isTest ? " 🧪" : ""} | \`${n.relation}\` | ${n.distance} | ${n.originSymbols.map((o) => `\`${o}\``).join(", ")} |`);
  }
  if (nodes.length > 60) out.push(`| _…and ${nodes.length - 60} more (\`--format json\`)_ | | | |`);
  out.push("", "</details>", "");

  out.push("---");
  const tool = opts.toolUrl ?? "Blast Radius";
  out.push(
    `<sub>Generated by ${tool} from Entire Graph · \`${short(r.range.base)}\`..\`${short(r.range.head)}\` · every row is backed by the graph path behind it</sub>`,
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
