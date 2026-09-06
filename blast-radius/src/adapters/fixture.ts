/** FixtureGraphProvider — recorded `entire graph` JSON from a directory. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { toChangeSet, toRadiusNodes } from "../domain/graph-mapping.js";
import { rawDiffResult, rawImpactResult } from "../domain/graph-schema.js";
import type { ChangeSet } from "../domain/model.js";
import type { CommitRange, GraphProvider, ImpactQuery } from "../ports.js";

const sanitize = (n: string) => n.replace(/[^A-Za-z0-9._-]+/g, "_");

export class FixtureGraphProvider implements GraphProvider {
  readonly kind = "fixture";
  constructor(private readonly dir: string) {}

  private async json(file: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(path.resolve(this.dir, file), "utf8"));
    } catch {
      return null;
    }
  }

  async diff(_range: CommitRange): Promise<ChangeSet> {
    const raw = await this.json("diff.json");
    if (raw === null) throw new Error(`fixture diff.json not found in ${this.dir}`);
    return toChangeSet(rawDiffResult.parse(raw));
  }

  async impact(q: ImpactQuery): Promise<{ nodes: ReturnType<typeof toRadiusNodes>; disambiguation: boolean }> {
    for (const cand of [
      `impact-${sanitize(q.name)}.json`,
      `impact-${sanitize(q.name.split(".").pop() ?? q.name)}.json`,
    ]) {
      const raw = await this.json(cand);
      if (raw === null) continue;
      const parsed = rawImpactResult.parse(raw);
      return { nodes: toRadiusNodes(parsed, q.name), disambiguation: parsed.disambiguation_required };
    }
    return { nodes: [], disambiguation: false };
  }
}
