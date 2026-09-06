/**
 * Resolve the stated intent of a change.
 *  1. the Entire-Checkpoint trailer on the head commit + its captured prompt
 *     (.entire/intent/<id>.json, or the checkpoint's own text)
 *  2. the commit subject/body as a fallback
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { keywords } from "../domain/scope-creep.js";
import type { IntentModel } from "../domain/model.js";

const TRAILER = /Entire-Checkpoint:\s*([A-Za-z0-9._-]+)/;

async function gitBody(repo: string, ref: string): Promise<string> {
  try {
    const { stdout } = await execa("git", ["-C", repo, "log", "-1", "--format=%B", ref]);
    return stdout;
  } catch {
    return "";
  }
}

async function capturedIntent(repo: string, id: string): Promise<string | null> {
  for (const rel of [`.entire/intent/${id}.json`, `.entire/intents/${id}.json`]) {
    try {
      const j = JSON.parse(await readFile(path.resolve(repo, rel), "utf8")) as Record<string, unknown>;
      const t = (j.prompt ?? j.body ?? j.title ?? j.summary) as string | undefined;
      if (t) return t;
    } catch {
      /* next */
    }
  }
  return null;
}

export interface IntentContext {
  readonly repo: string;
  readonly head: string;
  readonly prTitle?: string | undefined;
  readonly prBody?: string | undefined;
}

export async function resolveIntent(
  ctx: IntentContext,
): Promise<{ intent: IntentModel | null; checkpoint: string | undefined }> {
  const body = await gitBody(ctx.repo, ctx.head);
  const id = TRAILER.exec(body)?.[1];

  if (id) {
    const captured = await capturedIntent(ctx.repo, id);
    const text = captured ?? body.split("\n").filter((l) => !TRAILER.test(l)).join("\n").trim();
    if (text) {
      return { intent: { source: "checkpoint-trailer", text, keywords: keywords(text) }, checkpoint: id };
    }
  }

  const pr = `${ctx.prTitle ?? ""}\n${ctx.prBody ?? ""}`.trim();
  if (pr) return { intent: { source: "pr-body", text: pr, keywords: keywords(pr) }, checkpoint: id };

  const subject = body.split("\n")[0]?.trim();
  if (subject) {
    return { intent: { source: "commit-message", text: subject, keywords: keywords(subject) }, checkpoint: id };
  }
  return { intent: null, checkpoint: id };
}
