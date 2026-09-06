/** The one seam that matters: everything Blast Radius needs from Entire Graph. */
import type { Completeness } from "./domain/completeness.js";
import type { ChangeSet, RadiusNode } from "./domain/model.js";

export interface CommitRange {
  readonly base: string;
  readonly head: string;
}

export interface ImpactQuery {
  readonly name: string;
  readonly file: string | undefined;
}

export interface GraphProvider {
  readonly kind: string;
  diff(range: CommitRange): Promise<ChangeSet>;
  impact(
    q: ImpactQuery,
  ): Promise<{ nodes: RadiusNode[]; disambiguation: boolean; completeness: Completeness }>;
}
