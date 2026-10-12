// @vitest-environment happy-dom
import type { SearchHit } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import { COMMANDS, DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "../defaults.ts";
import { installDispatcher } from "../dispatcher.ts";
import { registerCommand } from "../../../lib/command-registry.ts";
import { mergeWithDefaults } from "../resolve.ts";
import { RpcError } from "../../../runtime/index.ts";
import { mount, press, settle, typeInto, type Mounted } from "../../../testing/dom.ts";
import { shellSession } from "../../../testing/shell-snapshot.ts";
import { useFocusEntry } from "../../../stores/focus-entry.ts";
import CommandPalette from "./CommandPalette.tsx";
import type { PaletteItem } from "./rank.ts";

const search = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => ({ rpc: { call: search.call } }),
}));

const runs = { split: vi.fn(), settings: vi.fn() };
const items: PaletteItem[] = [
  { id: "a1", group: "actions", title: "Open settings", searchTerms: ["Open settings"], run: runs.settings },
  {
    id: "a2",
    group: "actions",
    title: "Split pane",
    searchTerms: ["Split pane"],
    chord: ["Ctrl", "\\"],
    chordJoiner: "+",
    run: runs.split,
  },
  {
    id: "s1",
    group: "sessions",
    title: "pi-agentic",
    detail: "/home/ana/pi-agentic",
    searchTerms: ["pi-agentic"],
    run: () => {},
  },
];

let page: Mounted | null = null;
const onOpenChange = vi.fn();
const openSession = vi.fn();
beforeEach(() => {
  search.call.mockReset();
  search.call.mockResolvedValue({ hits: [] });
  openSession.mockReset();
  useFocusEntry.setState({ target: null });
  setLocale("en");
  runs.split.mockReset();
  runs.settings.mockReset();
  onOpenChange.mockReset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});
const open = async (list: PaletteItem[] = items) => {
  page = await mount(
    <TooltipProvider>
      <CommandPalette open onOpenChange={onOpenChange} items={list} openSession={openSession} />
    </TooltipProvider>,
  );
};
const input = () => document.querySelector("input") as HTMLInputElement;
const options = () => [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent);
const live = () => document.querySelector('[aria-live="polite"]')?.textContent;

describe("CommandPalette", () => {
  it("opens a labelled dialog with the input focused and the groups listed", async () => {
    await open();
    expect(document.querySelector("[data-pap-modal] [data-command-palette]")).not.toBeNull();
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("aria-label")).toBe("Search commands and sessions");
    expect([...document.querySelectorAll("[cmdk-group-heading]")].map((el) => el.textContent)).toEqual([
      "Actions",
      "Sessions",
    ]);
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("filters with its own ranking and runs the chosen row with Enter, closing first", async () => {
    await open();
    await typeInto(input(), "split");
    expect(options()).toHaveLength(1);
    await press(input(), { key: "Enter" });
    expect(runs.split).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("binds no digit chord while the palette is open: the real dispatcher claims none of them", async () => {
    const platform = "other";
    const { rules } = mergeWithDefaults(DEFAULT_KEYBINDINGS, [], KNOWN_COMMANDS);
    const claimed = vi.fn();
    const offs = COMMANDS.map((command) => registerCommand(command.id, () => void claimed(command.id)));
    const stop = installDispatcher({
      win: window,
      platform,
      rules: () => rules,
      shell: () => ({ mobile: false, treeOpen: false }),
    });
    try {
      await open();
      const events = [];
      for (const digit of "123456789") {
        events.push(await press(input(), { key: digit, code: `Digit${digit}`, ctrlKey: true }));
        events.push(await press(input(), { key: digit, code: `Digit${digit}`, altKey: true }));
        events.push(await press(input(), { key: digit, code: `Digit${digit}`, ctrlKey: true, altKey: true }));
      }
      expect([events.length, events.filter((event) => event.defaultPrevented).length]).toEqual([27, 0]);
      expect(claimed).not.toHaveBeenCalled();
    } finally {
      stop();
      offs.forEach((off) => off());
    }
  });

  it("says when nothing matches, and when no action does", async () => {
    await open();
    await typeInto(input(), "zz");
    expect(document.querySelector("[cmdk-empty]")?.textContent).toBe(
      "No match. Try a folder, a setting or an action.",
    );
    await typeInto(input(), "> zz");
    expect(document.querySelector("[cmdk-empty]")?.textContent).toBe("No matching action.");
  });

  it("announces the result count politely, with its own singular", async () => {
    await open();
    expect(live()).toBe("3 results");
    await typeInto(input(), "split");
    expect(live()).toBe("1 result");
  });

  it("shows an item's chord as a Kbd", async () => {
    await open();
    const row = [...document.querySelectorAll('[role="option"]')].find((el) =>
      el.textContent?.includes("Split"),
    );
    expect([...(row?.querySelectorAll("kbd kbd") ?? [])].map((k) => k.textContent)).toEqual(["Ctrl", "\\"]);
  });

  it("renders in French", async () => {
    setLocale("fr");
    await open();
    await typeInto(input(), "zz");
    expect(document.querySelector("[cmdk-empty]")?.textContent).toBe(
      "Aucun résultat. Essayez un dossier, un réglage ou une action.",
    );
    expect(live()).toBe("0 résultat");
    await settle();
  });

  it("renders no listbox while closed", async () => {
    page = await mount(
      <TooltipProvider>
        <CommandPalette open={false} onOpenChange={onOpenChange} items={items} openSession={openSession} />
      </TooltipProvider>,
    );
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  describe("transcript hits", () => {
    const NOW = 1_800_000_000_000;
    const hit = (id: string, label: string, snippet: string, minutes: number): SearchHit => ({
      sessionId: id,
      entryId: `${id}-e`,
      role: "assistant",
      at: NOW - minutes * 60_000,
      snippet,
      session: shellSession({ id, name: label }),
    });
    const hits = [
      hit("h1", "Cluster notes", "…the \u0002kube\u0003 cluster…", 5),
      hit("h2", "Ops", "restart \u0002kube\u0003-proxy", 180),
    ];
    const kubeSession: PaletteItem = {
      id: "s2",
      group: "sessions",
      title: "kube-ops",
      searchTerms: ["kube-ops"],
      run: () => {},
    };
    const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    const rows = () => [...document.querySelectorAll('[role="option"]')];
    beforeEach(() => vi.useFakeTimers({ now: NOW }));
    afterEach(() => vi.useRealTimers());

    it("lists the hits in their own group after Sessions, marking the matches, with label and age", async () => {
      search.call.mockResolvedValue({ hits });
      await open([kubeSession, ...items]);
      await typeInto(input(), "kube");
      await wait(150);
      expect(search.call).toHaveBeenCalledWith("search.query", { q: "kube", limit: 20 });
      expect([...document.querySelectorAll("[cmdk-group-heading]")].map((el) => el.textContent)).toEqual([
        "Sessions",
        "Transcripts",
      ]);
      const hitRows = rows().slice(1);
      expect(hitRows.map((row) => [...row.querySelectorAll("mark")].map((mark) => mark.textContent))).toEqual(
        [["kube"], ["kube"]],
      );
      expect(hitRows.map((row) => row.textContent)).toEqual([
        "…the kube cluster…Cluster notes · 5 min",
        "restart kube-proxyOps · 3 h",
      ]);
      expect(live()).toBe("3 results");
    });

    it("renders a hostile snippet as text", async () => {
      search.call.mockResolvedValue({
        hits: [hit("h1", "X", "<img src=x onerror=alert(1)>\u0002kube\u0003", 1)],
      });
      await open();
      await typeInto(input(), "kube");
      await wait(150);
      expect(document.querySelector("img")).toBeNull();
      expect(rows()[0]?.textContent).toContain("<img src=x onerror=alert(1)>");
    });

    it("opens the hit's session and asks the transcript to focus its entry, closing first", async () => {
      search.call.mockResolvedValue({ hits });
      await open();
      await typeInto(input(), "kube");
      await wait(150);
      await press(input(), { key: "Enter" });
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(openSession).toHaveBeenCalledWith("h1");
      expect(useFocusEntry.getState().target).toEqual({ sessionId: "h1", entryId: "h1-e" });
    });

    it("shows no Transcripts group for an actions-only query nor below 3 characters", async () => {
      search.call.mockResolvedValue({ hits });
      await open();
      await typeInto(input(), "> kube");
      await wait(300);
      await typeInto(input(), "ku");
      await wait(300);
      expect(search.call).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Transcripts");
    });

    it("says it is searching, without claiming that nothing matches", async () => {
      search.call.mockReturnValue(new Promise(() => {}));
      await open();
      await typeInto(input(), "kube");
      await wait(150);
      expect(document.querySelector("[data-search-status]")?.textContent).toBe("Searching transcripts…");
      expect(document.querySelector("[cmdk-empty]")).toBeNull();
    });

    it.each([
      ["timeout", "Search took too long. Try more precise words."],
      ["capacity", "Too many searches at once. Try again."],
      ["internal", "Search is not available right now."],
      ["worker_failed", "Search is not available right now."],
      ["constructor", "Search is not available right now."],
      ["toString", "Search is not available right now."],
    ])("shows the %s answer as one muted line", async (code, line) => {
      search.call.mockRejectedValue(new RpcError(code as never));
      await open();
      await typeInto(input(), "kube");
      await wait(150);
      expect(document.querySelector("[data-search-status]")?.textContent).toBe(line);
    });

    it("says it in French", async () => {
      setLocale("fr");
      search.call.mockRejectedValue(new RpcError("timeout"));
      await open();
      await typeInto(input(), "kube");
      await wait(150);
      expect(document.querySelector("[data-search-status]")?.textContent).toBe(
        "La recherche a pris trop de temps. Essayez des mots plus précis.",
      );
    });
  });
});
