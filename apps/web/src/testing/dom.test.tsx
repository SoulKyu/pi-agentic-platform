// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "./dom.ts";

describe("auto-unmount", () => {
  it("a test that never unmounts leaves a container behind while it runs", async () => {
    await mount(<p>leaked</p>);
    expect(document.body.textContent).toBe("leaked");
  });
  it("the next test starts with an empty document", () => {
    expect(document.body.textContent).toBe("");
  });
  it("an inline unmount still works and a second one is a no-op", async () => {
    const page = await mount(<p>once</p>);
    await page.unmount();
    await page.unmount();
    expect(document.body.textContent).toBe("");
  });
});
