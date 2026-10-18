import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { chord, palette, plural, stepUp, type PapInstance } from "./fixtures.ts";

const pageOn = (browserName: string) => {
  const pressed: string[] = [];
  const posts: { url: string; options: { data: unknown; headers: Record<string, string> } }[] = [];
  let status = 204;
  const page = {
    context: () => ({ browser: () => ({ browserType: () => ({ name: () => browserName }) }) }),
    keyboard: { press: async (keys: string) => void pressed.push(keys) },
    request: {
      post: async (url: string, options: { data: unknown; headers: Record<string, string> }) => {
        posts.push({ url, options });
        return { status: () => status };
      },
    },
  } as unknown as Page;
  return { page, pressed, posts, answer: (code: number) => void (status = code) };
};

describe("fixtures helpers", () => {
  it("opens the palette with Meta on WebKit and Control elsewhere", async () => {
    const webkit = pageOn("webkit");
    await palette(webkit.page);
    const chromium = pageOn("chromium");
    await palette(chromium.page);
    expect(webkit.pressed).toEqual(["Meta+k"]);
    expect(chromium.pressed).toEqual(["Control+k"]);
  });

  it("builds a chord from the platform modifier and keeps named keys as they are", async () => {
    const webkit = pageOn("webkit");
    await chord(webkit.page, "S");
    await chord(webkit.page, "Enter");
    const firefox = pageOn("firefox");
    await chord(firefox.page, "S");
    expect(webkit.pressed).toEqual(["Meta+s", "Meta+Enter"]);
    expect(firefox.pressed).toEqual(["Control+s"]);
  });

  it("confirms the owner password through the page's own session", async () => {
    const { page, posts, answer } = pageOn("chromium");
    const pap = {
      origin: "http://localhost:4000",
      owner: { username: "owner", password: "e2e-pw" },
    } as PapInstance;
    await stepUp(page, pap);
    expect(posts).toEqual([
      {
        url: "http://localhost:4000/auth/confirm",
        options: { data: { password: "e2e-pw" }, headers: { origin: "http://localhost:4000" } },
      },
    ]);
    answer(401);
    await expect(stepUp(page, pap)).rejects.toThrow(/401/);
  });

  it("exports the catalog's plural", () => {
    expect(plural("home.status.tasks", 1)).toBe("1 running task");
    expect(plural("home.status.tasks", 2)).toBe("2 running tasks");
  });
});
