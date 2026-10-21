import { PolicySettings } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import type { TestClient } from "../testing/ws-client.ts";
import { httpRequest } from "../testing/http-client.ts";
import { openOwner, outcome, type Owner, result } from "./testing/automation-bed.ts";

// Owner a6 and W5-R36 through the real socket: the step-up that guards trusted autonomy and an own host list.
// The tainted agent_remind / agent_delegate run itself (card, relaxed audit row) needs the handlers of Task 12 and
// joins the op matrix in Task 20's platform-ops.int.test.ts; the dispatcher half is pinned by dispatch.autonomy.test.ts.
let t: TestDaemon;
let owner: Owner;
let plain: TestClient;

beforeAll(async () => {
  t = await startTestDaemon({ steps: [{ text: "ok" }] });
  owner = await openOwner(t);
  // The same user, a browser session that never confirmed the password: no step-up.
  const reply = await httpRequest(`${t.base}/auth/login`, {
    method: "POST",
    headers: { origin: t.origin, "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "correct horse battery staple" }),
  });
  const header = reply.headers["set-cookie"];
  plain = await t.connect(((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? "");
});
afterAll(async () => {
  plain?.close();
  owner?.client.close();
  await t?.stop();
});

const setOwnerHosts = async (allowHosts: string[] | null): Promise<void> => {
  const read = result<{ revision: number }>(await owner.client.call("policy.getSettings", {}));
  const value = PolicySettings.parse({ allowHosts });
  expect(outcome(await owner.client.call("policy.setSettings", { value, baseRevision: read.revision }))).toBe(
    "ok",
  );
};
const create = (client: TestClient, name: string, extra: object = {}) =>
  client.call("agents.create", { input: { name, ...extra } as never });
const createdId = (frame: Awaited<ReturnType<typeof create>>): string => result<{ id: string }>(frame).id;
const update = async (client: TestClient, agentId: string, input: object) => {
  const view = result<{ revision: number; input: { name: string } }>(
    await owner.client.call("agents.get", { agentId }),
  );
  return client.call("agents.update", {
    agentId,
    baseRevision: view.revision,
    input: { name: view.input.name, ...input } as never,
  });
};

describe("a host list of the agent's own against the owner's list (W5-R36)", () => {
  it("needs step-up when the list reaches a host the owner's does not, and not otherwise", async () => {
    await setOwnerHosts(["a.example", "*.corp.example"]);
    expect(outcome(await create(plain, "Wide", { allowHosts: ["evil.example"] }))).toBe("step_up_required");
    expect(outcome(await create(plain, "Wide", { allowHosts: ["a.example", "evil.example"] }))).toBe(
      "step_up_required",
    );
    // AVM2-E12: an exact name under the owner's wildcard widens (it reaches private ranges the wildcard cannot); a narrower wildcard does not.
    expect(outcome(await create(plain, "Exact", { allowHosts: ["a.example", "db.corp.example"] }))).toBe(
      "step_up_required",
    );
    const narrow = await create(plain, "Narrow", { allowHosts: ["a.example", "*.db.corp.example"] });
    expect(outcome(narrow)).toBe("ok");
    const nothing = await create(plain, "Nothing", { allowHosts: [] });
    expect(outcome(nothing)).toBe("ok");
  });

  it("judges an update from no list (null) to a list the same way", async () => {
    const id = createdId(await create(owner.client, "Atlas"));
    expect(outcome(await update(plain, id, { allowHosts: ["evil.example"] }))).toBe("step_up_required");
    expect(outcome(await update(plain, id, { allowHosts: ["a.example"] }))).toBe("ok");
    // Own list to a bigger list is the existing rule (M11R44), unchanged.
    expect(outcome(await update(plain, id, { allowHosts: ["a.example", "b.example"] }))).toBe(
      "step_up_required",
    );
    expect(outcome(await update(owner.client, id, { allowHosts: ["a.example", "b.example"] }))).toBe("ok");
  });

  it("asks when the owner has no list (null): the proxy reads it as no host, so a list of its own widens (W5-R64 I2)", async () => {
    await setOwnerHosts(null);
    expect(outcome(await create(plain, "Free", { allowHosts: ["whatever.example"] }))).toBe(
      "step_up_required",
    );
    expect(outcome(await create(plain, "Closed", { allowHosts: [] }))).toBe("ok");
  });
});

describe("trusted autonomy (owner a6)", () => {
  it("needs step-up to turn on, none to turn off, and shows in the agent's view", async () => {
    const id = createdId(await create(owner.client, "Bolt"));
    expect(outcome(await update(plain, id, { trustedAutonomy: true }))).toBe("step_up_required");
    expect(outcome(await update(owner.client, id, { trustedAutonomy: true }))).toBe("ok");
    expect(
      result<{ input: { trustedAutonomy: boolean } }>(await plain.call("agents.get", { agentId: id })).input,
    ).toMatchObject({ trustedAutonomy: true });
    expect(outcome(await update(plain, id, { trustedAutonomy: false }))).toBe("ok");
  });

  it("needs step-up for a bigger host list while it is on, even with the owner's list as any host", async () => {
    const id = createdId(
      await create(owner.client, "Echo", { allowHosts: ["a.example"], trustedAutonomy: true }),
    );
    expect(
      outcome(await update(plain, id, { allowHosts: ["a.example", "b.example"], trustedAutonomy: true })),
    ).toBe("step_up_required");
  });

  it("needs step-up to create an agent with it on", async () => {
    expect(outcome(await create(plain, "Born", { trustedAutonomy: true }))).toBe("step_up_required");
  });
});
