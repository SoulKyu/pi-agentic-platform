import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AvailableModelsData, MAX_LISTED_MODELS, ModelSummary } from "@pap/contracts";
import { z } from "zod";
import { writePrivateFile } from "../../kernel/fs/private-write.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { LiveSession } from "./live-types.ts";
import type { SessionRow } from "./store.ts";

export const BOX_MODELS_FILE = "box-models.json";
const MAX_BOXES = 200;

const BoxModelsFile = z.object({
  version: z.literal(1),
  boxes: z.record(
    z.string().min(1).max(1024),
    z.object({ at: z.number().finite(), models: z.array(ModelSummary).max(MAX_LISTED_MODELS) }),
  ),
});

/** The box a row runs in: `agent:<agentId>` or `project:<box home>`. */
export const boxKeyOf = (row: SessionRow, boxHomeOf?: (row: SessionRow) => string | null): string =>
  row.agentId !== undefined ? `agent:${row.agentId}` : `project:${boxHomeOf?.(row) ?? row.cwd}`;

/** The extension models each box's worker last listed: ids only, nothing secret. Kept in `$PAP_HOME/box-models.json`. */
export interface BoxModels {
  get(box: string): readonly ModelSummary[];
  /** Keeps the list as the worker gave it; nothing is written when it is the one already held. */
  record(box: string, models: readonly ModelSummary[]): void;
}

export function createBoxModels(options: {
  /** None: memory only. */
  papHome?: string;
  now(): number;
  logger: Logger;
}): BoxModels {
  const { papHome, now, logger } = options;
  const path = papHome === undefined ? null : join(papHome, BOX_MODELS_FILE);
  let boxes: Map<string, { at: number; models: ModelSummary[] }> | null = null;
  // Read once, at the first use. A missing file is a first run; any other trouble reads as empty, said once (no content).
  function load() {
    if (boxes) return boxes;
    boxes = new Map();
    if (path === null) return boxes;
    try {
      const parsed = BoxModelsFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success) throw new Error("invalid");
      for (const [key, value] of Object.entries(parsed.data.boxes)) boxes.set(key, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("box_models_unreadable", {});
    }
    return boxes;
  }
  function save(held: Map<string, { at: number; models: ModelSummary[] }>): void {
    if (path === null) return;
    const file = { version: 1, boxes: Object.fromEntries(held) };
    try {
      writePrivateFile(path, Buffer.from(JSON.stringify(file)));
    } catch (error) {
      logger.warn("box_models_unwritable", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
    }
  }
  return {
    get: (box) => load().get(box)?.models ?? [],
    record(box, models) {
      const held = load();
      const next = models.slice(0, MAX_LISTED_MODELS);
      const before = held.get(box);
      if (before && JSON.stringify(before.models) === JSON.stringify(next)) return;
      held.delete(box);
      held.set(box, { at: now(), models: next });
      if (held.size > MAX_BOXES) {
        const oldest = [...held].sort((a, b) => a[1].at - b[1].at).slice(0, held.size - MAX_BOXES);
        for (const [key] of oldest) held.delete(key);
      }
      save(held);
    },
  };
}

/**
 * Right after a VM worker is ready: asks it for its models once and keeps the answer for the box. Never awaited by the
 * start; a failure is said once-per-start with no worker text.
 */
export function refreshBoxModels(
  session: Pick<LiveSession, "command" | "busy">,
  box: string,
  store: BoxModels,
  logger: Logger,
): void {
  // A worker that already runs lists from its run's snapshot; skipping it keeps the refresh off a run's start. A prompt
  // sent right after can still meet it: the worker rereads the same files, unchanged, so the run is not disturbed.
  if (session.busy()) return;
  void (async () => {
    try {
      const answer = await session.command({ type: "get_available_models" });
      const parsed = answer.ok ? AvailableModelsData.safeParse(answer.data) : null;
      if (!parsed?.success) throw new Error("unreadable");
      store.record(box, parsed.data.models);
    } catch {
      logger.warn("box_models_refresh_failed", {});
    }
  })();
}
