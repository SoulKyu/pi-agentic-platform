import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { createLogger } from "../../kernel/logger.ts";
import { AGENT, type Bed, makeBed } from "./mirror-fixtures.ts";
import { topLevelIdOf } from "./mirror-id.ts";
import { createProvenance, entryFacts } from "./mirror-line.ts";
import { type LineParser, withTopId } from "./mirror-parse.ts";
import type { ReadAt } from "./mirror-index.ts";
import { createQuota } from "./mirror-quota.ts";
import { openMirror } from "./mirror.ts";

// The state of the mirror tests, as live bindings: each test file imports what it reads and calls `fresh()` per case.
export const MiB = 1024 * 1024;
export let bed: Bed;
export let clock: FakeClock;
export let announced: string[];
export let parsed: number;
let parsers: LineParser[];
const lines: Array<Record<string, unknown>> = [];
export const log = {
  lines,
  logger: createLogger({
    level: "debug",
    clock: createFakeClock(),
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  }),
};

/** The thread's job done in place, so the many small cases do not start a thread; the real one is used for the 12 MiB case. */
const inlineParser = (): LineParser => ({
  parse: (line, first) => {
    parsed++;
    const text = line.toString("utf8");
    try {
      return Promise.resolve(withTopId(entryFacts(JSON.parse(text), first), topLevelIdOf(line)));
    } catch {
      return Promise.resolve({ ok: false, reason: "not_json" });
    }
  },
  stats: () => ({ threadLines: parsed }),
  stop: () => Promise.resolve(),
});

export function open(
  options: {
    limitBytes?: number;
    minFreeMb?: number;
    free?: () => number;
    parser?: LineParser;
    provenance?: ReturnType<typeof createProvenance>;
    createOnly?: boolean;
    maxIds?: number;
    read?: ReadAt;
  } = {},
) {
  const parser = options.parser ?? inlineParser();
  parsers.push(parser);
  const free = options.free ?? (() => 100_000);
  return openMirror(bed.path, {
    clock,
    logger: log.logger,
    agentId: AGENT,
    parser,
    provenance: options.provenance ?? createProvenance(),
    quota: createQuota({
      papHome: bed.root,
      clock,
      minFreeMb: options.minFreeMb ?? 0,
      statfs: () => ({ bavail: free() * 256, bsize: 4096 }),
    }),
    limitBytes: options.limitBytes ?? 1024 * MiB,
    announce: (kind) => void announced.push(kind),
    ...(options.createOnly === undefined ? {} : { createOnly: options.createOnly }),
    ...(options.maxIds === undefined ? {} : { maxIds: options.maxIds }),
    ...(options.read === undefined ? {} : { read: options.read }),
  });
}

export const fileText = () => readFileSync(bed.path, "utf8");
export const keptFiles = () =>
  existsSync(join(bed.folder, "replaced"))
    ? readdirSync(join(bed.folder, "replaced")).filter((name) => !name.endsWith(".ids"))
    : [];
export const refusals = () =>
  log.lines
    .filter((line) => line.msg === "agent_mirror_refused")
    .map((line) => ({ agentId: line.agentId, reason: line.reason }));

export async function cleanup(): Promise<void> {
  for (const parser of parsers) await parser.stop();
  bed.dispose();
}
export const fresh = () => {
  bed = makeBed();
  clock = createFakeClock();
  announced = [];
  parsed = 0;
  parsers = [];
  log.lines.length = 0;
};
