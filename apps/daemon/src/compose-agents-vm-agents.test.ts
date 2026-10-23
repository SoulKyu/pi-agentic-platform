import { describe, expect, it, vi } from "vitest";
import { composeAgentsLink } from "./compose-agents-vm-agents.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import { createKataBackend } from "./modules/agent-vm/index.ts";
import { createFakeVmd } from "./modules/agent-vm/testing/fake-vmd.ts";

/*
 * S1 item 6 mutants, each run for real:
 *  - M-link-bypasses-backend: the link sends `vm.stop` to pap-vmd itself again (no `stopVm`): killed by "a stop through the link
 *    clears the backend's running record".
 *  - M-record-cleared-before-stop: the backend clears `running` before pap-vmd answered (a failed stop): killed by "keeps it when
 *    pap-vmd could not stop the VM".
 */
const ID = "scout-0001";
const TASK = "c".repeat(32);

function bed() {
  const fake = createFakeVmd();
  const images = { started: vi.fn(), stopped: vi.fn() };
  const backend = createKataBackend({ client: fake, images, logger: silentLogger, notice: () => {} });
  const { link } = composeAgentsLink({
    runtime: { stop: async () => {}, resume: () => {} },
    require: async () => {},
    client: fake,
    stopVm: (agentId, taskKey) => backend.stop(agentId, taskKey),
    papHome: "/nonexistent",
    clock: createFakeClock(),
    logger: silentLogger,
    forget: () => {},
  });
  return { fake, images, link };
}

describe("the agent link's stops go through the backend", () => {
  it("a stop through the link clears the backend's running record of the thread VM, not of a task's", async () => {
    const { fake, images, link } = bed();
    fake.running.add(ID);
    fake.running.add(`${ID}/${TASK}`);
    await link.stop(ID);
    expect(fake.running.size).toBe(0);
    expect(images.stopped.mock.calls).toEqual([[ID]]);
  });

  it("keeps it when pap-vmd could not stop the VM, and a second ask finishes", async () => {
    const { fake, images, link } = bed();
    fake.running.add(ID);
    fake.failNext("vm.stop", "failed");
    await expect(link.stop(ID)).rejects.toBeDefined();
    expect(images.stopped).not.toHaveBeenCalled();
    await link.stop(ID);
    expect(images.stopped.mock.calls).toEqual([[ID]]);
  });
});
