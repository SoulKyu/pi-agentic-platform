// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount, unmountAll } from "./dom.ts";

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

  // The document is left clean either way: a failing mount must not keep the others mounted.
  const failOnRemove = (container: HTMLElement, message: string) =>
    Object.defineProperty(container, "remove", {
      configurable: true,
      value: () => {
        throw new Error(message);
      },
    });
  const restore = (container: HTMLElement) => {
    Reflect.deleteProperty(container, "remove");
    container.remove();
  };

  it("unmounts every mount when one throws, then rethrows that error", async () => {
    const bad = await mount(<p>bad</p>);
    const good = await mount(<p>good</p>);
    failOnRemove(bad.container, "first");
    await expect(unmountAll()).rejects.toThrow("first");
    expect(good.container.isConnected).toBe(false);
    restore(bad.container);
  });

  it("rethrows an AggregateError when several fail", async () => {
    const one = await mount(<p>one</p>);
    const two = await mount(<p>two</p>);
    const last = await mount(<p>last</p>);
    failOnRemove(one.container, "one");
    failOnRemove(two.container, "two");
    const failure = await unmountAll().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual(["one", "two"]);
    expect(last.container.isConnected).toBe(false);
    restore(one.container);
    restore(two.container);
  });
});
