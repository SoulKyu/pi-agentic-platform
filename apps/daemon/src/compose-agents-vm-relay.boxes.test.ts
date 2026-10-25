import { describe, expect, it } from "vitest";
import { composeRelay } from "./compose-agents-vm-relay.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import { FakeChild, grant } from "./modules/agent-vm/testing/relay-link-bed.ts";
import { boxRow, lateWithBoxes, PROJECT } from "./testing/late-boxes.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The relay composed over a fake child and the project-box late binding; resolves with the child once the relay is ready. */
async function started(over: Parameters<typeof lateWithBoxes>[0] = {}, bound = true) {
  const { derived } = lateWithBoxes(over);
  const child = new FakeChild();
  const relay = composeRelay({
    clock: createFakeClock(),
    logger: silentLogger,
    env: {},
    piHostEntry: "/x/main.js",
    piHostExecArgv: [],
    piAgentDir: "/x",
    testProviderScript: null,
    claudeToken: { load: () => null, onChange: () => () => {} } as never,
    ownerSecrets: {} as never,
    bridgeAddress: false,
    relay: { fork: () => child },
    relayExecArgv: undefined,
    bridgeReady: undefined,
    late: () => (bound ? { ...derived, turnsOf: () => 0, windowEnded: () => {} } : null),
  });
  if (relay === null) throw new Error("no relay");
  await relay.start();
  child.ready();
  await settle();
  return { relay, child };
}
const policies = (child: FakeChild) =>
  child.sent.filter((message) => (message as { type: string }).type === "box_policy");

describe("the relay's policy of a project box", () => {
  it("gets the owner's models for the project's launch, not the nothing it got before the project source", async () => {
    const { relay, child } = await started({ models: [{ provider: "acme", id: "m-1" }], token: true });
    relay.grant(grant(1, { kind: "project", id: PROJECT }));
    await settle();
    expect(policies(child)).toEqual([
      {
        type: "box_policy",
        box: { kind: "project", id: PROJECT },
        models: [{ provider: "acme", id: "m-1" }],
        claude: true,
        claudeToken: "tok-x",
        blocked: null,
      },
    ]);
  });

  it("is blocked `budget` when the owner's day is spent", async () => {
    const { relay, child } = await started({ overBudget: () => true });
    relay.grant(grant(1, { kind: "project", id: PROJECT }));
    await settle();
    expect(policies(child)).toEqual([expect.objectContaining({ blocked: "budget" })]);
  });

  it("gets nothing for a project being deleted, and before the late binding (the relay refuses every request)", async () => {
    for (const bed of [
      await started({ rows: { [PROJECT]: boxRow({ deleting: true }) } }),
      await started({}, false),
    ]) {
      bed.relay.grant(grant(1, { kind: "project", id: PROJECT }));
      await settle();
      expect(policies(bed.child)).toEqual([expect.objectContaining({ models: [], claude: false })]);
    }
  });
});
