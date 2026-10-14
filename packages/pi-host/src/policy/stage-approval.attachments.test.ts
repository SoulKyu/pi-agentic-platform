import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { CLEAN, handRepo, SAFE_SHELL } from "./cover-bed.ts";

// Rebase item 2: in supervised mode a session reads its own attachments unasked and is asked for anything else under
// attachments/, by the built-in read tools and by a read-only shell command alike.
const OWN = "11111111-aaaa-4aaa-8aaa-111111111111";
const OTHER = "22222222-bbbb-4bbb-8bbb-222222222222";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let own: string;
let other: string;
let pending: string;
beforeAll(async () => {
  bed = await createPipelineBed();
  handRepo(bed.cwd, CLEAN);
  const root = join(bed.papHome, "attachments");
  own = join(root, OWN, "a1", "own.txt");
  other = join(root, OTHER, "b1", "other.txt");
  pending = join(root, "pending", "p1");
  for (const file of [own, other, pending]) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "x\n");
  }
});
afterAll(() => bed.dispose());

const supervised = () => PolicyRules.parse({ ...interactiveRules, approvalMode: "supervised" });
const harness = () => bed.harness({ rules: supervised, shell: SAFE_SHELL, sessionId: OWN });

describe("stage 03: attachments", () => {
  it("reads the session's own attachment without a card, by tool and by command", async () => {
    const h = harness();
    expect(await h.run("read", { path: own })).toBeUndefined();
    expect(await h.run("bash", { command: `cat ${own}` })).toBeUndefined();
    expect(h.asks).toEqual([]);
  });

  it("asks for another session's attachment and for pending, by tool and by command", async () => {
    const h = harness();
    for (const file of [other, pending]) {
      await h.run("read", { path: file });
      await h.run("bash", { command: `cat ${file}` });
    }
    expect(h.asks).toHaveLength(4);
  });
});
