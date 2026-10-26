// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../../runtime/index.ts";
import { alerts, button, click, settle } from "../../../testing/dom.ts";
import { forgetExtensions } from "../extension-read.ts";
import { availabilityBed, current, showAvailability, switchOf } from "./availability-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => forgetExtensions());

type Bed = ReturnType<typeof availabilityBed>["bed"];

/** Holds the answers of `method` (Pi's helper still working) until `release`. */
function hold(bed: Bed, method: string) {
  const answer = bed.handlers[method];
  const held: Array<() => void> = [];
  bed.handlers[method] = (params) =>
    new Promise((resolve, reject) =>
      held.push(() => {
        try {
          resolve(answer?.(params));
        } catch (failure) {
          reject(failure instanceof Error ? failure : new Error(String(failure)));
        }
      }),
    );
  return async () => {
    for (const go of held.splice(0)) go();
    await settle();
  };
}

const opened = async () => {
  const { bed } = availabilityBed();
  const page = await showAvailability();
  await settle();
  await click(button(page.container, "Show the models of OpenAI"));
  const checked = (label: string) => switchOf(page.container, label).getAttribute("aria-checked");
  return { bed, page, checked };
};

describe("a switch shows what was asked (Pi writes, then reads again, each in seconds)", () => {
  it("asked.held: from the click, through the write and the read after it, the switch and its count follow the click", async () => {
    const { bed, page, checked } = await opened();
    const write = hold(bed, "models.setEnabled");
    const reread = hold(bed, "models.overview");
    await click(switchOf(page.container, "gpt-b name"));
    expect(checked("gpt-b name")).toBe("true");
    expect(checked("OpenAI")).toBe("true");
    await write();
    expect(switchOf(page.container, "gpt-b name").disabled).toBe(false);
    expect(checked("gpt-b name")).toBe("true");
    await reread();
    expect(checked("gpt-b name")).toBe("true");
  });

  it("asked.failed: a write that fails puts the switch back to the list at once", async () => {
    const { bed, page, checked } = await opened();
    bed.handlers["models.setEnabled"] = () => {
      throw new RpcError("conflict");
    };
    hold(bed, "models.overview");
    await click(switchOf(page.container, "gpt-a name"));
    await settle();
    expect(alerts(page.container)).toHaveLength(1);
    expect(checked("gpt-a name")).toBe("true");
  });

  it("asked.list-wins: once the reads are in, the list is shown even where it differs from the click", async () => {
    const { bed, page, checked } = await opened();
    // Another writer put the old list back: the write is answered, the list does not follow it.
    bed.handlers["models.setEnabled"] = () => ({ patterns: ["openai/gpt-a", "mine/m1"] });
    await click(switchOf(page.container, "gpt-b name"));
    await settle();
    expect(checked("gpt-b name")).toBe("false");
  });
});
