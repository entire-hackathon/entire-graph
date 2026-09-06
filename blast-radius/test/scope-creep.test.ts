import { describe, expect, it } from "vitest";
import { detectScopeCreep, keywords, splitIdent } from "../src/domain/scope-creep.js";
import type { BlastRadius, ChangeSet, ChangedSymbol, IntentModel } from "../src/domain/model.js";

const emptyRadius: BlastRadius = {
  origin: [],
  nodes: [],
  sectionTotals: { callers: 0, callees: 0, type_consumers: 0, data_flows: 0, co_changes: 0, siblings: 0 },
};
const intent = (t: string): IntentModel => ({ source: "commit-message", text: t, keywords: keywords(t) });
const changed = (qn: string, deps: number, over: Partial<ChangedSymbol> = {}): ChangedSymbol => ({
  ref: { name: qn.split(".").pop()!, qualifiedName: qn, kind: "method", file: `src/${qn.split(".")[0]!.toLowerCase()}.ts`, line: 1, external: false },
  changeType: "body_changed",
  dependentsCount: deps,
  oldSignature: undefined,
  newSignature: undefined,
  ...over,
});
const cs = (symbols: ChangedSymbol[]): ChangeSet => ({ base: "a", head: "b", checkpoint: undefined, symbols, changedFiles: [] });

describe("splitIdent / keywords", () => {
  it("splits camelCase and paths", () => {
    expect(splitIdent("RedirectService.handleRequest")).toEqual(["redirect", "service", "handle", "request"]);
  });
  it("keeps meaningful terms, drops stopwords", () => {
    const k = keywords("Add rate limiting to the redirect endpoint");
    expect(k).toContain("rate");
    expect(k).toContain("limit");
    expect(k).toContain("redirect");
    expect(k).not.toContain("add");
    expect(k).not.toContain("the");
  });
});

describe("detectScopeCreep", () => {
  it("stays silent without an intent for a narrow change", () => {
    // no intent → no keyword signal; deps 3 < wide threshold → nothing to flag
    expect(detectScopeCreep(cs([changed("Db.query", 3)]), null, emptyRadius)).toEqual([]);
  });
  it("flags an unrelated change with dependents", () => {
    const f = detectScopeCreep(
      cs([changed("Db.query", 9, { changeType: "signature_changed" })]),
      intent("rate limit the redirect endpoint"),
      emptyRadius,
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.symbol.qualifiedName).toBe("Db.query");
    expect(f[0]?.reason).toMatch(/no vocabulary overlap/);
  });
  it("does not flag a change that matches the intent", () => {
    const f = detectScopeCreep(
      cs([changed("RateLimiter.take", 5)]),
      intent("rate limit the redirect endpoint"),
      emptyRadius,
    );
    expect(f).toEqual([]);
  });
  it("flags a wide-reaching change regardless of intent", () => {
    const f = detectScopeCreep(cs([changed("Config.load", 20)]), null, emptyRadius);
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("high");
  });
  it("never flags newly added symbols", () => {
    const f = detectScopeCreep(cs([changed("New.thing", 30, { changeType: "added" })]), intent("x"), emptyRadius);
    expect(f).toEqual([]);
  });
});
