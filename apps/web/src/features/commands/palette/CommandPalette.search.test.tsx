// @vitest-environment happy-dom
import type { SearchHit } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, typeInto } from "../../../testing/dom.ts";
import { shellSession } from "../../../testing/shell-snapshot.ts";
import CommandPalette from "./CommandPalette.tsx";
import type { PaletteItem } from "./rank.ts";

const search = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => ({ rpc: { call: search.call } }),
}));

const NOW = 1_800_000_000_000;
const hit = (id: string, projectId: string, label: string): SearchHit => ({
  sessionId: id,
  entryId: `${id}-e`,
  role: "assistant",
  at: NOW - 60_000,
  snippet: "the \u0002kube\u0003 cluster",
  session: shellSession({ id, name: label, projectId }),
});
const items: PaletteItem[] = [
  { id: "a1", group: "actions", title: "Open settings", searchTerms: ["kube settings"], run: () => {} },
  { id: "s1", group: "sessions", title: "kube-ops", searchTerms: ["kube-ops"], run: () => {} },
];
const input = () => document.querySelector("input") as HTMLInputElement;
const options = () => [...document.querySelectorAll('[role="option"]')].map((row) => row.textContent ?? "");
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const open = (scope: { projectId: string | null; projectName: string | null }) =>
  mount(
    <TooltipProvider>
      <CommandPalette open onOpenChange={vi.fn()} items={items} openSession={vi.fn()} search={scope} />
    </TooltipProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  search.call.mockReset();
  search.call.mockResolvedValue({ hits: [hit("h1", "p1", "Cluster notes"), hit("h2", "p2", "Other repo")] });
});
afterEach(() => vi.useRealTimers());

describe("the palette in transcript-search mode (§3.2)", () => {
  it("names the project in its input, lists no command or item, and only that project's hits", async () => {
    await open({ projectId: "p1", projectName: "api" });
    expect(input().getAttribute("aria-label")).toBe("Search transcripts in api");
    expect(document.body.textContent).toContain("Type 3 characters or more to search the transcripts.");
    await typeInto(input(), "kube");
    await wait(150);
    expect(search.call).toHaveBeenCalledWith("search.query", { q: "kube", limit: 20 });
    expect(options()).toHaveLength(1);
    expect(options()[0]).toContain("Cluster notes");
    expect(document.body.textContent).not.toContain("kube-ops");
    expect(document.body.textContent).not.toContain("Open settings");
  });

  it("lists every project's hits under All projects, and says when none matches", async () => {
    await open({ projectId: null, projectName: null });
    expect(input().getAttribute("aria-label")).toBe("Search transcripts");
    await typeInto(input(), "kube");
    await wait(150);
    expect(options()).toHaveLength(2);
    search.call.mockResolvedValue({ hits: [] });
    await typeInto(input(), "nothing here");
    await wait(150);
    expect(document.body.textContent).toContain("No transcript matches.");
  });
});
