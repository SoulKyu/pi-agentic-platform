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

const named = (id: string, name: string, bg = "#0e1626"): CustomTheme => ({
  id,
  name,
  base: "night",
  roles: { ...roles, bg },
});

/** The scripted server: settings.get answers in order, the first settings.set conflicts when `conflict` is true. */
function scripted(gets: unknown[], conflict: boolean) {
  let writes = 0;
  const sets: unknown[] = [];
  return {
    sets,
    rpc: {
      call: vi.fn(async (method: string, params: unknown) => {
        if (method === "settings.get") return gets.shift();
        sets.push(params);
        if (conflict && writes++ === 0) throw new RpcError("conflict");
        return { revision: 9 };
      }),
    } as never,
  };
}
const doc = (customThemes: CustomTheme[]) => ({ ...DEFAULT_ACCOUNT, customThemes });
const change = async (customThemes: CustomTheme[]) => {
  useAppearanceStore.getState().setAccount(doc(customThemes));
  await vi.advanceTimersByTimeAsync(400);
  await drain();
};

describe("the cap notice: only when this device edited its themes and the merge goes over 16", () => {
  it("another device swaps a theme at the cap: no toast, on load and at a socket reopen", async () => {
    useAppearanceStore.setState({ account: doc(themes(16)) }); // a stale cache of 16
    controller = startAppearance(window);
    const swapped = [...themes(16).filter((one) => one.id !== "t5"), ...themes(1, 99)];
    const s = scripted(
      [
        { value: doc(swapped), revision: 2 },
        { value: doc(swapped), revision: 2 },
      ],
      false,
    );
    await syncAccountAppearance(s.rpc);
    await syncAccountAppearance(s.rpc);
    await drain();
    expect(toasts).toEqual([]);
    expect(s.sets).toEqual([]);
  });

  it("this device adds at the cap: a toast that says why", async () => {
    controller = startAppearance(window);
    const s = scripted(
      [
        { value: doc(themes(15)), revision: 1 },
        { value: doc(themes(16)), revision: 2 },
      ],
      true,
    );
    await syncAccountAppearance(s.rpc);
    await change([...themes(15), ...themes(1, 100)]);
    expect(useAppearanceStore.getState().account.customThemes).toHaveLength(16);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.tone).toBe("error");
    expect(toasts[0]?.message).toContain("16");
  });

  it("a duplicate whose id collides is renamed, then cut at the cap: a toast", async () => {
    controller = startAppearance(window);
    const server = [...themes(15), named("x", "Night Control copy", "#202020")];
    const s = scripted(
      [
        { value: doc(themes(15)), revision: 1 },
        { value: doc(server), revision: 2 },
      ],
      true,
    );
    await syncAccountAppearance(s.rpc);
    await change([...themes(15), named("x", "Night Control copy", "#101010")]);
    expect(toasts).toHaveLength(1);
  });

  it("a theme that shares its name with a kept one is cut: a toast", async () => {
    controller = startAppearance(window);
    const base = [...themes(14), named("n1", "Night Control copy")];
    const s = scripted(
      [
        { value: doc(base), revision: 1 },
        { value: doc([...base, named("o1", "Other")]), revision: 2 },
      ],
      true,
    );
    await syncAccountAppearance(s.rpc);
    await change([...base, named("n2", "Night Control copy", "#303030")]);
    expect(toasts).toHaveLength(1);
  });

  it("stays quiet when nothing is cut", async () => {
    controller = startAppearance(window);
    const s = scripted([{ value: null, revision: 0 }], false);
    await syncAccountAppearance(s.rpc);
    await change(themes(2));
    expect(toasts).toEqual([]);
  });
});
