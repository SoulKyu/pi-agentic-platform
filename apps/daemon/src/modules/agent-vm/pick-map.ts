import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AgentId, IMAGE_TAG, PapError } from "@pap/contracts";
import { z } from "zod";
import { readJsonBounded } from "../../kernel/json-bounded.ts";

/** One package entry of the profile build: the exact source `settings.json` spells and the entry the image wrote for it. */
export interface WrittenEntry {
  readonly source: string;
  readonly written: string;
}

/**
 * AVM-E42 I1: the guest narrows the image's list by the sources the image WROTE (the build rewrites them: an unpinned npm name
 * gets its installed version, a git URL becomes `git:host/path`, a local path becomes `local/<name>`). The picks the daemon holds are
 * the exact spellings, so each is mapped to its written entry; one the image did not write is returned in `missing` for the caller
 * to log, never dropped without a trace.
 */
export function imageEntriesOf(
  picks: readonly string[],
  written: readonly WrittenEntry[],
): { entries: string[]; missing: string[] } {
  const bySource = new Map(written.map((one) => [one.source, one.written]));
  const entries: string[] = [];
  const missing: string[] = [];
  for (const pick of picks) {
    const found = bySource.get(pick);
    if (found === undefined) missing.push(pick);
    else entries.push(found);
  }
  return { entries, missing };
}

/** 64 pairs of two 512-character spellings per image, 16 images per agent at most. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_PER_AGENT = 16;
const Entry = z.object({ source: z.string().max(512), written: z.string().max(512) }).strict();
const FileShape = z
  .object({
    version: z.literal(1),
    images: z.record(z.string().regex(IMAGE_TAG), z.record(AgentId, z.array(Entry).max(64))),
  })
  .strict();

interface Logger {
  warn(code: string, fields: Record<string, unknown>): void;
}

export interface ImageEntriesOptions {
  /** Where the pairs live between runs: beside the images, never inside a tree whose digest is a tag (AVM-E44). */
  readonly file?: string;
  /** The Kata backend: a launch whose picks have no record is refused, not passed on as spelled. */
  readonly strict?: boolean;
}

interface Held {
  readonly agentId: string;
  readonly image: string;
  readonly written: readonly WrittenEntry[];
}
/** Image tags are shared (two agents on one profile get one tag), the pairs are kept per agent and image (I2). */
const keyOf = (agentId: string, image: string): string => `${agentId} ${image}`;

function load(file: string, logger: Logger): Map<string, Held> {
  const held = new Map<string, Held>();
  const read = readJsonBounded(file, FileShape, MAX_FILE_BYTES);
  if (read === "damaged") logger.warn("agent_image_entries_damaged", {});
  if (read === null || read === "damaged") return held;
  for (const [image, agents] of Object.entries(read.images))
    for (const [agentId, written] of Object.entries(agents))
      held.set(keyOf(agentId, image), { agentId, image, written });
  return held;
}

/**
 * The entries each image's profile build wrote, kept for the launch (the build records them, the launch maps its picks through
 * them). They are keyed by the agent and the image tag the VM runs on (S1): a thread VM on an older image keeps mapping through that image's
 * pairs while a task records those of a newer one. With a `file` they are loaded at boot; without, in memory (the process backend).
 */
export function createImageEntries(logger: Logger, options: ImageEntriesOptions = {}) {
  const { file, strict = false } = options;
  const byKey = file === undefined ? new Map<string, Held>() : load(file, logger);
  /** Atomic: the new file is complete or the old one stays. */
  function save(): void {
    if (file === undefined) return;
    const images: Record<string, Record<string, readonly WrittenEntry[]>> = {};
    for (const held of byKey.values()) (images[held.image] ??= {})[held.agentId] = held.written;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const next = `${file}.tmp`;
    writeFileSync(next, JSON.stringify({ version: 1, images }), { mode: 0o600 });
    renameSync(next, file);
  }
  return {
    /** The pairs the build of `image` wrote; the agent keeps its 16 newest images. */
    record(agentId: string, image: string, written: readonly WrittenEntry[]): void {
      byKey.delete(keyOf(agentId, image));
      byKey.set(keyOf(agentId, image), { agentId, image, written });
      const mine = [...byKey].filter(([, held]) => held.agentId === agentId);
      for (const [old] of mine.slice(0, Math.max(0, mine.length - MAX_IMAGES_PER_AGENT))) byKey.delete(old);
      save();
    },
    /** Every (agent, image) pair held: the images pap-vmd must keep for agents not started since the boot (I2). */
    held(): ReadonlyArray<{ readonly agentId: string; readonly image: string }> {
      return [...byKey.values()].map(({ agentId, image }) => ({ agentId, image }));
    },
    /** The agent was deleted: the pairs of all its images go. */
    forget(agentId: string): void {
      let dropped = false;
      for (const [key, held] of byKey) if (held.agentId === agentId) dropped = byKey.delete(key) || dropped;
      if (dropped) save();
    },
    /** `null` stays `null` (every package). Without a recorded build the picks go on as they are (or are refused when `strict`). */
    toImage(agentId: string, image: string, sources: readonly string[] | null): string[] | null {
      if (sources === null) return null;
      const held = byKey.get(keyOf(agentId, image));
      if (held === undefined) {
        logger.warn("agent_pick_image_unknown", { agentId, picks: sources.length });
        if (strict) throw new PapError("worker_failed");
        return [...sources];
      }
      const mapped = imageEntriesOf(sources, held.written);
      if (mapped.missing.length > 0)
        logger.warn("agent_pick_not_in_image", { agentId, count: mapped.missing.length });
      return mapped.entries;
    },
  };
}

export type ImageEntries = ReturnType<typeof createImageEntries>;
