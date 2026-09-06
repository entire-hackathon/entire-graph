/** EntireGraphCliProvider — shells out to the real `entire graph` binary. */
import { execa } from "execa";
import { toChangeSet, toRadiusNodes } from "../domain/graph-mapping.js";
import { rawDiffResult, rawImpactResult } from "../domain/graph-schema.js";
import type { ChangeSet } from "../domain/model.js";
import type { CommitRange, GraphProvider, ImpactQuery } from "../ports.js";

export interface CliOptions {
  /** how to invoke the graph: `["entire","graph"]` or `["/path/to/entire-graph"]`. */
  readonly argv0: readonly string[];
  readonly repo: string;
  readonly profile?: "fast" | "full";
  /** query the committed tree — reuses a warm `index --head` cache (much faster in CI). */
  readonly head?: boolean;
  readonly timeoutMs?: number;
}

export class EntireGraphCliProvider implements GraphProvider {
  readonly kind = "entire-graph-cli";
  constructor(private readonly opts: CliOptions) {}

  private async run(args: string[], timeoutMs?: number): Promise<unknown> {
    const [bin, ...pre] = this.opts.argv0;
    const r = await execa(bin!, [...pre, ...args], {
      timeout: timeoutMs ?? this.opts.timeoutMs ?? 240_000,
      stripFinalNewline: true,
    });
    return JSON.parse(String(r.stdout ?? ""));
  }

  /** Prewarm one committed-tree cache variant so `impact --head` is fast. */
  async warmIndex(): Promise<void> {
    try {
      await execa(this.opts.argv0[0]!, [...this.opts.argv0.slice(1), "index", "--repo", this.opts.repo, "--head", "--profile", this.opts.profile ?? "fast"], {
        timeout: 600_000,
      });
    } catch {
      /* best effort — impact still works without it, just slower */
    }
  }

  async diff(range: CommitRange): Promise<ChangeSet> {
    const raw = await this.run(
      ["diff", "--repo", this.opts.repo, "--base", range.base, "--head", range.head, "--json"],
      600_000,
    );
    return toChangeSet(rawDiffResult.parse(raw));
  }

  async impact(q: ImpactQuery): Promise<{ nodes: ReturnType<typeof toRadiusNodes>; disambiguation: boolean }> {
    const args = [
      "impact", "--repo", this.opts.repo, "--symbol", q.name,
      "--format", "json", "--depth", "2", "--profile", this.opts.profile ?? "full",
    ];
    if (q.file) args.push("--file", q.file);
    if (this.opts.head) args.push("--head");
    const raw = await this.run(args);
    const parsed = rawImpactResult.parse(raw);
    return { nodes: toRadiusNodes(parsed, q.name), disambiguation: parsed.disambiguation_required };
  }
}
