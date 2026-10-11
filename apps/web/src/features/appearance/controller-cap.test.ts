// @vitest-environment happy-dom
import type { CustomTheme } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { useAppearanceStore } from "./appearance-store.ts";
import { startAppearance, syncAccountAppearance } from "./controller.ts";
import { DEFAULT_ACCOUNT, DEFAULT_DEVICE } from "./model.ts";
import { roles } from "./theme-test-kit.ts";

const toasts = vi.hoisted(() => [] as Array<{ message: string; tone?: string }>);
vi.mock("@pap/ui", async (original) => ({
  ...(await original<typeof import("@pap/ui")>()),
  toast: (input: { message: string; tone?: string }) => toasts.push(input),
}));
vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

const themes = (count: number, from = 0): CustomTheme[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `t${from + i}`,
    name: `T${from + i}`,
    base: "night",
    roles,
  }));
const drain = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

let controller: { stop(): void } | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  toasts.length = 0;
  useAppearanceStore.setState({ account: DEFAULT_ACCOUNT, device: DEFAULT_DEVICE, accountStatus: "local" });
});
afterEach(() => {
  controller?.stop();
  vi.useRealTimers();
});

describe("a merge that drops this device's new theme at the 16-theme cap", () => {
  it("says so instead of ending in a silent save", async () => {
    controller = startAppearance(window);
    const gets = [
      { value: { ...DEFAULT_ACCOUNT, customThemes: themes(15) }, revision: 1 },
      { value: { ...DEFAULT_ACCOUNT, customThemes: themes(16) }, revision: 2 }, // another device added one
    ];
    let writes = 0;
    const rpc = {
      call: vi.fn(async (method: string) => {
        if (method === "settings.get") return gets.shift();
        if (writes++ === 0) throw new RpcError("conflict");
        return { revision: 3 };
      }),
    };
    await syncAccountAppearance(rpc as never);
    useAppearanceStore.getState().setAccount({
      ...useAppearanceStore.getState().account,
      customThemes: [...themes(15), ...themes(1, 100)],
    });
    await vi.advanceTimersByTimeAsync(400);
    await drain();
    expect(useAppearanceStore.getState().account.customThemes).toHaveLength(16);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.tone).toBe("error");
    expect(toasts[0]?.message).toContain("16");
  });

  it("stays quiet when nothing is dropped", async () => {
    controller = startAppearance(window);
    const rpc = {
      call: vi.fn(async (method: string) =>
        method === "settings.get" ? { value: null, revision: 0 } : { revision: 1 },
      ),
    };
    await syncAccountAppearance(rpc as never);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, customThemes: themes(2) });
    await vi.advanceTimersByTimeAsync(400);
    await drain();
    expect(toasts).toEqual([]);
  });
});
