// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { button, click, hasButton, mount, text, type Mounted } from "../../testing/dom.ts";
import { QueueStrip } from "./QueueStrip.tsx";

let page: Mounted | null = null;
const strip = async (queue: object, onClear = vi.fn()) => {
  page = await mount(
    <QueueStrip queue={{ steering: [], followUp: [], count: 0, bytes: 0, ...queue }} onClear={onClear} />,
  );
  return page.container;
};
afterEach(async () => {
  setLocale("en");
  await page?.unmount();
  page = null;
});

describe("QueueStrip", () => {
  it("shows nothing for an empty queue", async () => {
    const container = await strip({});
    expect(container.textContent).toBe("");
  });

  it("lists steering and follow-up previews, each labelled, with the count", async () => {
    const container = await strip({ steering: ["one"], followUp: ["two", "three"], count: 3 });
    expect(text(container)).toContain("Waiting · 3");
    const rows = [...container.querySelectorAll("li")].map((row) => row.textContent);
    expect(rows).toEqual(["Steerone", "Follow-uptwo", "Follow-upthree"]);
    expect(container.textContent).not.toContain("more");
  });

  it("says how many more wait beyond the previews, and never claims the follow-ups are empty (M2R-12)", async () => {
    const container = await strip({ steering: ["a", "b"], followUp: [], count: 5 });
    expect(text(container)).toContain("3 more");
    expect(container.querySelector("[data-queue-more]")?.textContent).toBe("3 more");
    expect(container.textContent).not.toContain("Follow-up");
  });

  it("uses the plural of the locale, without concatenating words", async () => {
    setLocale("fr");
    const one = await strip({ steering: ["a"], followUp: [], count: 2 });
    expect(one.querySelector("[data-queue-more]")?.textContent).toBe("1 de plus");
    await page?.unmount();
    const many = await strip({ steering: ["a"], followUp: [], count: 4 });
    expect(many.querySelector("[data-queue-more]")?.textContent).toBe("3 de plus");
  });

  it("renders previews as text only", async () => {
    const container = await strip({
      steering: ['<img src=x onerror="alert(1)"><b>bold</b>'],
      count: 1,
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("li")?.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("styles steering and follow-up with tokens, and Clear asks the composer", async () => {
    const onClear = vi.fn();
    const container = await strip({ steering: ["s"], followUp: ["f"], count: 2 }, onClear);
    const rows = [...container.querySelectorAll("li")];
    expect(rows[0]?.className).toContain("text-human-text");
    expect(rows[1]?.className).toContain("text-muted");
    expect(hasButton(container, "Clear")).toBe(true);
    await click(button(container, "Clear"));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
