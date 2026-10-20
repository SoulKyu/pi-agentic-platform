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

/** 64 pairs of two 512-character spellings per profile tag, one tag per agent at most. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const Entry = z.object({ source: z.string().max(512), written: z.string().max(512) }).strict();
const FileShape = z
  .object({
    version: z.literal(1),
    profiles: z.record(z.string().regex(IMAGE_TAG), z.array(Entry).max(64)),
    agents: z.record(AgentId, z.string().regex(IMAGE_TAG)),
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
  readonly tag: string | null;
  readonly written: readonly WrittenEntry[];
}

function load(file: string, logger: Logger): Map<string, Held> {
  const held = new Map<string, Held>();
  const read = readJsonBounded(file, FileShape, MAX_FILE_BYTES);
  if (read === "damaged") logger.warn("agent_image_entries_damaged", {});
  if (read === null || read === "damaged") return held;
  for (const [agentId, tag] of Object.entries(read.agents)) {
    const written = read.profiles[tag];
    if (written !== undefined) held.set(agentId, { tag, written });
  }
  return held;
}

/**
 * The entries each agent's profile build wrote, kept for the launch (the build records them, the launch maps its picks through
 * them). With a `file` the pairs are kept by the profile image tag and loaded at boot; without, in memory (the process backend).
 */
export function createImageEntries(logger: Logger, options: ImageEntriesOptions = {}) {
  const { file, strict = false } = options;
  const byAgent = file === undefined ? new Map<string, Held>() : load(file, logger);
  /** Atomic: the new file is complete or the old one stays. */
  function save(): void {
    if (file === undefined) return;
    const profiles: Record<string, readonly WrittenEntry[]> = {};
    const agents: Record<string, string> = {};
    for (const [agentId, held] of byAgent)
      if (held.tag !== null) {
        profiles[held.tag] = held.written;
        agents[agentId] = held.tag;
      }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const next = `${file}.tmp`;
    writeFileSync(next, JSON.stringify({ version: 1, profiles, agents }), { mode: 0o600 });
    renameSync(next, file);
  }
  return {
    /** `profileTag` (the profile image the pairs belong to) makes them durable; without it they live until the process ends. */
    record(agentId: string, written: readonly WrittenEntry[], profileTag?: string): void {
      byAgent.set(agentId, { tag: profileTag ?? null, written });
      save();
    },
    /** The agent was deleted, or its image was replaced: its pairs go, and a tag nobody else uses goes with them. */
    forget(agentId: string): void {
      if (byAgent.delete(agentId)) save();
    },
    /** `null` stays `null` (every package). Without a recorded build the picks go on as they are (or are refused when `strict`). */
    toImage(agentId: string, sources: readonly string[] | null): string[] | null {
      if (sources === null) return null;
      const held = byAgent.get(agentId);
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
