import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLEAN, handRepo, SAFE_SHELL } from "./cover-bed.ts";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { SANDBOX_SOURCE } from "./tool-kind.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let atlas: string;
beforeAll(async () => {
  bed = await createPipelineBed();
  atlas = join(bed.papHome, "agents", "atlas-1a2b");
  await mkdir(atlas, { recursive: true });
  handRepo(atlas, CLEAN);
});
afterAll(() => bed.dispose());

const causes = {
  list: [{ tool: "todo", source: "/x/ext/todo.ts", at: 5, count: 1, markable: true }],
  older: 0,
};
const rulesOf = (extra: Record<string, unknown> = {}) =>
  PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: "supervised",
    agentHome: atlas,
    sandbox: { required: true, network: true },
    allowHosts: ["allowed.example"],
    autonomy: { hosts: ["allowed.example"] },
    ...extra,
  });
const harness = (rules: PolicyRules) =>
  bed.harness({
    cwd: atlas,
    rules: () => rules,
    tools: { bash: { path: SANDBOX_SOURCE, sandboxNetwork: true } },
    taint: { current: () => true, causes: () => causes },
    shell: SAFE_SHELL,
  });

// Mutant M8 (decision 117, A3): `evaluate-once.ts` sends the causes without the `call.tainted` gate. Autonomy judges this
// call as clean, so the card is the mode's own question, not the taint card: it must not name causes it is not asking about.
describe("the causes go only on a card that is asked because of the taint", () => {
  it("leaves them off the card of a call that autonomy lifted out of the taint", async () => {
    const h = harness(rulesOf());
    await h.run("bash", { command: "pnpm test" });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.tainted).toBe(false);
    expect(h.asks[0]).not.toHaveProperty("taintCauses");
  });

  it("puts them on the card of the same call without autonomy", async () => {
    const h = harness(rulesOf({ autonomy: null }));
    await h.run("bash", { command: "pnpm test" });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.tainted).toBe(true);
    expect(h.asks[0]?.taintCauses).toEqual(causes);
  });
});
