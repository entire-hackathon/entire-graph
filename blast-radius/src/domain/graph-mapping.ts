/** Pure mappers: validated raw `entire graph` JSON → domain value objects. */
import type { RawDiffResult, RawImpactResult, ImpactSectionName } from "./graph-schema.js";
import { IMPACT_SECTIONS } from "./graph-schema.js";
import type {
  ChangeSet,
  ChangeType,
  ChangedSymbol,
  RadiusNode,
  RadiusSection,
  SymbolRef,
} from "./model.js";

const TEST_FILE = [
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /(^|\/)test_[^/]+\.py$/,
];
const TEST_NAME = [/^Test[A-Z_]/, /^test_/, /_test$/];

function isTest(ref: SymbolRef): boolean {
  const f = (ref.file ?? "").replace(/\\/g, "/");
  if (TEST_FILE.some((re) => re.test(f))) return true;
  return TEST_NAME.some((re) => re.test(ref.name));
}

const CHANGE_TYPE: Record<string, ChangeType> = {
  added: "added",
  removed: "removed",
  renamed: "renamed",
  signature_changed: "signature_changed",
  body_changed: "body_changed",
};
const NON_SYMBOL = new Set(["module", "file", "section", "document"]);
const NON_CODE_LANG = new Set(["Markdown", "JSON", "YAML", "TOML", "XML", "HTML"]);
// struct fields / vars / consts: a rename is technically an API change, but for a
// scope review the behavioural signal is method / function / class / type changes.
// entire-graph also inflates field dependent counts (every struct reference), so
// including them drowns the report. Keep them out of the change set.
const MEMBER_KINDS = new Set(["field", "variable", "property", "constant", "enum_member", "parameter"]);

export function toChangeSet(raw: RawDiffResult): ChangeSet {
  const symbols: ChangedSymbol[] = [];
  const files = new Set<string>();
  for (const file of raw.files) {
    files.add(file.path);
    if (file.language && NON_CODE_LANG.has(file.language)) continue;
    for (const c of file.changes) {
      if (NON_SYMBOL.has(c.kind)) continue;
      if (MEMBER_KINDS.has(c.kind)) continue;
      const line = c.after_start_line ?? c.before_start_line;
      const name = c.new_name ?? c.name;
      symbols.push({
        ref: {
          name,
          qualifiedName: name,
          kind: c.kind,
          file: c.new_path ?? file.path,
          line: line && line > 0 ? line : undefined,
          external: false,
        },
        changeType:
          c.reconciliation === "RENAMED" ? "renamed" : (CHANGE_TYPE[c.type] ?? "unknown"),
        dependentsCount: c.dependents_count,
        oldSignature: c.old_signature,
        newSignature: c.new_signature,
      });
    }
  }
  return { base: raw.base, head: raw.head, checkpoint: raw.checkpoint, symbols, changedFiles: [...files] };
}

const SECTION_RELATION: Record<ImpactSectionName, string> = {
  callers: "CALLED_BY",
  callees: "CALLS",
  type_consumers: "USES_TYPE",
  data_flows: "DATA_FLOWS",
  co_changes: "FILE_CHANGES_WITH",
  siblings: "SIBLING",
};
const SECTION_DOMAIN: Record<ImpactSectionName, RadiusSection> = {
  callers: "callers",
  callees: "callees",
  type_consumers: "type_consumers",
  data_flows: "data_flows",
  co_changes: "co_changes",
  siblings: "siblings",
};

export function toRadiusNodes(raw: RawImpactResult, origin: string): RadiusNode[] {
  const out: RadiusNode[] = [];
  for (const section of IMPACT_SECTIONS) {
    for (const e of raw[section].entries) {
      const ep = e.endpoint;
      const qn = ep.qualified_name && ep.qualified_name.length > 0 ? ep.qualified_name : ep.name;
      const ref: SymbolRef = {
        name: ep.name,
        qualifiedName: qn,
        kind: ep.kind,
        file: ep.file_path,
        line: ep.start_line,
        external: ep.external ?? false,
      };
      const rel = e.relation?.toUpperCase();
      out.push({
        ref,
        section: SECTION_DOMAIN[section],
        relation:
          rel === "USES_TYPE" || rel === "PARAM_TYPE" || rel === "RETURNS_TYPE"
            ? rel
            : SECTION_RELATION[section],
        distance: e.depth && e.depth > 0 ? e.depth : 1,
        viaChain: e.via ? e.via.split(/\s*(?:->|,)\s*/).filter(Boolean) : [],
        originSymbols: [origin],
        isTest: isTest(ref),
      });
    }
  }
  return out;
}
