import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { InitRecord } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { enableKnowledge } from "../../kernel/fs/knowledge.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakeProjectsPort } from "./testing/fake-projects.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const inits: InitRecord[] = [];
let bed: ReturnType<typeof build>;
function build(knowledgeRootOf: (row: { cwd: string }, scope: string) => string | null) {
  return createServiceBed(
    { createSessionsStore, createSessionsService, loadTranscriptReader },
    {
      projects: { ...fakeProjectsPort(), knowledgeRootOf },
      start: (_index, init) => (inits.push(init), { kind: "ready" }),
    },
  );
}
afterEach(() => {
  inits.length = 0;
  return bed.dispose();
});

describe("the knowledge folder in the init record", () => {
  it("names <root>/knowledge for a session whose project root has OKF", async () => {
    bed = build(() => bed.work);
    enableKnowledge(bed.work, new Date());
    await bed.service.create(bed.work, OWNER);
    expect(inits[0]?.knowledge).toEqual({ path: join(bed.work, "knowledge") });
  });

  it("reads the lane's worktree, not the main checkout", async () => {
    const lane = (): string => join(bed.work, "lane");
    bed = build((row) => (row.cwd === lane() ? lane() : bed.work));
    mkdirSync(lane());
    enableKnowledge(lane(), new Date());
    await bed.service.create(lane(), OWNER);
    expect(inits[0]?.knowledge).toEqual({ path: join(lane(), "knowledge") });
    await bed.service.create(bed.work, OWNER);
    expect(inits[1]).not.toHaveProperty("knowledge");
  });

  it("has no knowledge key without OKF in the root, or when index.md is not a regular file", async () => {
    bed = build(() => bed.work);
    await bed.service.create(bed.work, OWNER);
    expect(inits[0]).not.toHaveProperty("knowledge");
    mkdirSync(join(bed.work, "knowledge", "index.md"), { recursive: true });
    await bed.service.create(bed.work, OWNER);
    expect(inits[1]).not.toHaveProperty("knowledge");
  });

  it("treats an outside-project folder (null root) as no OKF", async () => {
    bed = build(() => null);
    enableKnowledge(bed.work, new Date());
    await bed.service.create(bed.work, OWNER);
    expect(inits[0]).not.toHaveProperty("knowledge");
  });

  it.skipIf(process.getuid?.() === 0)("an unreadable knowledge folder does not fail the launch", async () => {
    bed = build(() => bed.work);
    enableKnowledge(bed.work, new Date());
    chmodSync(join(bed.work, "knowledge"), 0o000);
    try {
      await bed.service.create(bed.work, OWNER);
    } finally {
      chmodSync(join(bed.work, "knowledge"), 0o755);
    }
    expect(inits).toHaveLength(1);
    expect(inits[0]).not.toHaveProperty("knowledge");
  });
});
