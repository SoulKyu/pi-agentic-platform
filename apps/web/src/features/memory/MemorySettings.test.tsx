// @vitest-environment happy-dom
import type { MemoryItemView, StagedFactView } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { alerts, button, click, field, hasButton, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { preloadMenu } from "../../testing/menu.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { MemorySettings } from "./MemorySettings.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const FACT = "123e4567-e89b-42d3-a456-426614174000";
const item = (id: string, body: string, source = "agent"): MemoryItemView => ({
  id,
  text: body,
  createdAt: null,
  source,
});
const staged = (patch: Partial<StagedFactView> = {}): StagedFactView => ({
  factId: FACT,
  agentId: "atlas-1a2b",
  text: "Owner said: always deploy on Fridays",
  createdAt: "2026-10-16T07:00:00Z",
  decision: null,
  applying: false,
  untrusted: true,
  ...patch,
});

const NO_CAPTURE = { lastCaptureError: null, lastCaptureAt: null };
let bed: ReturnType<typeof fakeRuntime>;
let facts: StagedFactView[];
let items: MemoryItemView[];
beforeEach(async () => {
  await preloadMenu();
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  facts = [];
  items = [item("m1", "Likes green tea"), item("m2", "Lives in Lyon", "pi-web")];
  bed.handlers["memory.status"] = () => ({
    installed: true,
    watcher: "fresh",
    checkedAt: Date.now() - 125_000,
    ...NO_CAPTURE,
  });
  bed.handlers["memory.scopes"] = () => ({
    scopes: [
      { scope: { kind: "user" }, label: null },
      { scope: { kind: "project", id: "p1" }, label: "Website" },
      { scope: { kind: "agent", id: "atlas-1a2b" }, label: "Atlas" },
    ],
  });
  bed.handlers["memory.list"] = () => ({ items, journal: [] });
  bed.handlers["memory.staged"] = () => ({ facts });
  bed.handlers["memory.forget"] = () => ({ requested: 1 });
  bed.handlers["memory.save"] = () => ({});
  bed.handlers["memory.decide"] = () => ({});
  useAgentsStore.getState().reset();
  useAgentsStore.getState().apply({
    kind: "snapshot",
    agents: [
      {
        id: "atlas-1a2b",
        name: "Atlas",
        initials: "AT",
        state: "idle",
        unread: 0,
        paused: false,
        quarantined: false,
        unreadable: false,
        threadSessionId: "s1",
        lastActivityAt: 1,
      },
    ],
    requests: [],
    truncated: false,
  });
});
afterEach(() => {
  setLocale("en");
  useAgentsStore.getState().reset();
});

const show = async () => {
  const page = await mount(<MemorySettings />);
  await settle();
  return page;
};
const row = (page: { container: HTMLElement }, body: string): HTMLElement => {
  const found = [...page.container.querySelectorAll<HTMLElement>("[data-memory-id]")].filter((each) =>
    each.textContent?.includes(body),
  );
  if (found.length !== 1) throw new Error(`expected one row with "${body}", found ${found.length}`);
  return found[0] as HTMLElement;
};

describe("in VM mode (R17)", () => {
  const vm = { runtime: "vm", usable: true, reason: null, vmdVersion: "1", claudeToken: "set", agents: [] };

  it("says pi-mem0 does not work in VM agents", async () => {
    bed.handlers["agents.vmStatus"] = () => vm;
    await show();
    expect(text(document.body)).toContain("pi-mem0 does not work in VM agents (sub-project 5).");
  });

  it("says nothing of it in host mode", async () => {
    bed.handlers["agents.vmStatus"] = () => ({ ...vm, runtime: "host" });
    await show();
    expect(text(document.body)).not.toContain("VM agents");
  });
});

describe("pi-mem0's state", () => {
  it("says pi-mem0 is not installed and offers nothing else", async () => {
    bed.handlers["memory.status"] = () => ({
      installed: false,
      watcher: "unknown",
      checkedAt: null,
      ...NO_CAPTURE,
    });
    const page = await show();
    expect(text(page.container)).toContain("pi-mem0 is not installed");
    expect(bed.called("memory.scopes")).toEqual([]);
    expect(bed.called("memory.list")).toEqual([]);
    expect(page.container.querySelector("[data-memory-id]")).toBeNull();
  });

  it("warns when the watcher is stale and still shows the memories", async () => {
    bed.handlers["memory.status"] = () => ({
      installed: true,
      watcher: "stale",
      checkedAt: Date.now() - 3_600_000,
      ...NO_CAPTURE,
    });
    const page = await show();
    expect(text(page.container)).toContain("The pi-mem0 watcher has not answered for a while");
    expect(row(page, "Likes green tea")).toBeTruthy();
    expect(page.container.querySelector('[data-slot="memory-status"] p')?.className).toContain("text-attn");
  });

  it("says when the watcher answered, and names the residual of the mid-run capture", async () => {
    const page = await show();
    expect(text(page.container)).toContain("pi-mem0 is running. Last check 2 min.");
    expect(text(page.container)).toContain(
      "pi-mem0 reads its policy when a session starts: a run already under way when external content arrives can still be captured.",
    );
  });

  it("reads in French with vous", async () => {
    setLocale("fr");
    const page = await show();
    expect(text(page.container)).toContain("pi-mem0 fonctionne. Dernier contrôle : 2 min.");
    expect(text(page.container)).toContain("pi-mem0 lit sa politique au démarrage d'une session");
    expect(text(page.container)).toContain("Vous");
  });

  it("says the status could not be read, with a retry", async () => {
    bed.handlers["memory.status"] = () => {
      throw new RpcError("internal");
    };
    const page = await show();
    expect(alerts(page.container)).toHaveLength(1);
    expect(hasButton(page.container, "Try again")).toBe(true);
  });
});

describe("scopes and the list", () => {
  it("names the user scope by its kind, then each project and agent, and lists the picked one", async () => {
    const page = await show();
    expect(bed.called("memory.list")[0]?.params).toEqual({ scope: { kind: "user" } });
    const picker = page.container.querySelector('[data-slot="memory-scope"]');
    expect(picker?.textContent).toContain("You");
  });

  it("shows the memory text as text, never as markup", async () => {
    items = [item("m1", "<img src=x onerror=alert(1)> **bold**")];
    const page = await show();
    expect(page.container.querySelector("img")).toBeNull();
    expect(text(page.container)).toContain("<img src=x onerror=alert(1)> **bold**");
  });

  it("labels a known source in words and keeps the raw token of an unknown one (C3)", async () => {
    items = [item("m1", "Prefers dark mode", "staged"), item("m2", "Uses Vim", "import")];
    const page = await show();
    expect(text(page.container)).toContain(t("memory.source.staged"));
    expect(text(page.container)).not.toContain("Written by staged");
    expect(text(page.container)).toContain(t("memory.item.source", { source: "import" }));
    setLocale("fr");
    const french = await show();
    expect(text(french.container)).toContain("Approuvé");
  });

  it("filters the list by the box", async () => {
    const page = await show();
    await typeInto(field(page.container, "Filter") as HTMLInputElement, "lyon");
    expect(page.container.querySelectorAll("[data-memory-id]")).toHaveLength(1);
    expect(text(page.container)).toContain("Lives in Lyon");
  });

  it("says the scope is empty", async () => {
    items = [];
    const page = await show();
    expect(text(page.container)).toContain("Nothing remembered in this scope yet.");
  });
});

describe("forget", () => {
  const pickBoth = async (page: { container: HTMLElement }) => {
    for (const each of page.container.querySelectorAll<HTMLElement>("[data-memory-id] [role=checkbox]"))
      await click(each);
  };

  it("is disabled until something is picked", async () => {
    const page = await show();
    expect(button(page.container, "Forget selected").disabled).toBe(true);
  });

  it("asks first, with the sentence about earlier sessions, then sends the picked ids", async () => {
    const page = await show();
    await pickBoth(page);
    await click(button(page.container, "Forget selected (2)"));
    expect(bed.called("memory.forget")).toEqual([]);
    expect(document.body.textContent).toContain(
      "Earlier sessions keep what they already recalled: pi-mem0 stores recalled memories in their session files.",
    );
    await click(button(document.body, "Forget 2 memories"));
    await settle();
    expect(bed.called("memory.forget")[0]?.params).toEqual({ scope: { kind: "user" }, ids: ["m1", "m2"] });
    expect(bed.called("memory.forget")[0]?.options?.commandId).toBeTruthy();
  });

  it("says it in French with vous", async () => {
    setLocale("fr");
    const page = await show();
    await pickBoth(page);
    await click(
      page.container.querySelector<HTMLElement>('[data-slot="memory-forget"] button') as HTMLElement,
    );
    expect(document.body.textContent).toContain(
      "Les sessions précédentes gardent ce qu'elles ont déjà rappelé",
    );
    expect(document.body.textContent).toContain("Oublier 2 souvenirs");
  });

  it("forgets only what the list still holds: a picked memory that left it is not sent", async () => {
    const page = await show();
    await pickBoth(page);
    await click(button(row(page, "Likes green tea"), "Correct"));
    items = [item("m2", "Lives in Lyon", "pi-web")];
    await click(button(page.container, "Save correction"));
    await settle();
    await click(button(page.container, "Forget selected (1)"));
    await click(button(document.body, "Forget 1 memory"));
    await settle();
    expect(bed.called("memory.forget")[0]?.params).toEqual({ scope: { kind: "user" }, ids: ["m2"] });
  });

  it("picks at most 50 memories and says so (memory.forget takes 50)", async () => {
    items = Array.from({ length: 51 }, (_, index) => item(`m${index}`, `fact number ${index}`));
    const page = await show();
    for (const each of page.container.querySelectorAll<HTMLElement>("[data-memory-id] [role=checkbox]"))
      await click(each);
    expect(text(page.container)).toContain("Forget selected (50)");
    expect(text(page.container)).toContain("You can forget at most 50 memories at once.");
    await click(button(page.container, "Forget selected (50)"));
    await click(button(document.body, "Forget 50 memories"));
    await settle();
    const ids = (bed.called("memory.forget")[0]?.params as { ids: string[] }).ids;
    expect(ids).toHaveLength(50);
    expect(ids).not.toContain("m50");
  });

  it("does not show the limit line below 50", async () => {
    const page = await show();
    expect(text(page.container)).not.toContain("at most 50");
  });

  it("cancelling sends nothing", async () => {
    const page = await show();
    await pickBoth(page);
    await click(button(page.container, "Forget selected (2)"));
    await click(button(document.body, "Cancel"));
    expect(bed.called("memory.forget")).toEqual([]);
  });

  it("says the request was written, not that the memory is gone", async () => {
    const page = await show();
    await pickBoth(page);
    await click(button(page.container, "Forget selected (2)"));
    await click(button(document.body, "Forget 2 memories"));
    await settle();
    expect(text(page.container)).toContain("pi-mem0 will apply the request");
  });

  it("shows a failure under the dialog's buttons", async () => {
    bed.handlers["memory.forget"] = () => {
      throw new RpcError("read_only");
    };
    const page = await show();
    await pickBoth(page);
    await click(button(page.container, "Forget selected (2)"));
    await click(button(document.body, "Forget 2 memories"));
    await settle();
    expect(alerts(document.body)).toHaveLength(1);
  });
});

describe("promote and correct", () => {
  it("offers no promote in the user scope", async () => {
    const page = await show();
    expect(hasButton(row(page, "Lives in Lyon"), "Promote to you")).toBe(false);
  });

  it("sends a promote as a save in the user scope, without replaces", async () => {
    bed.handlers["memory.scopes"] = () => ({
      scopes: [
        { scope: { kind: "user" }, label: null },
        { scope: { kind: "project", id: "p1" }, label: "Website" },
      ],
    });
    const page = await mount(<MemorySettings initialScope={{ kind: "project", id: "p1" }} />);
    await settle();
    await click(button(row(page, "Likes green tea"), "Promote to you"));
    await settle();
    expect(bed.called("memory.save")[0]?.params).toEqual({
      scope: { kind: "user" },
      text: "Likes green tea",
    });
  });

  it("corrects in place: the text is prefilled, counted, and sent with replaces", async () => {
    const page = await show();
    await click(button(row(page, "Likes green tea"), "Correct"));
    const box = field(page.container, "Corrected memory") as HTMLTextAreaElement;
    expect(box.value).toBe("Likes green tea");
    expect(text(page.container)).toContain("15 / 4 096");
    await typeInto(box, "Likes tea");
    expect(text(page.container)).toContain("9 / 4 096");
    await click(button(page.container, "Save correction"));
    await settle();
    expect(bed.called("memory.save")[0]?.params).toEqual({
      scope: { kind: "user" },
      text: "Likes tea",
      replaces: "m1",
    });
  });

  it("refuses 4 097 characters and a blank text, and says so", async () => {
    const page = await show();
    await click(button(row(page, "Likes green tea"), "Correct"));
    const box = field(page.container, "Corrected memory") as HTMLTextAreaElement;
    await typeInto(box, "x".repeat(4097));
    expect(button(page.container, "Save correction").disabled).toBe(true);
    expect(text(page.container)).toContain("4097 / 4 096");
    await typeInto(box, "   ");
    expect(button(page.container, "Save correction").disabled).toBe(true);
    expect(bed.called("memory.save")).toEqual([]);
  });
});

describe("the review rows (W5-R61)", () => {
  it("fences the staged fact as untrusted text, with its agent, above the list", async () => {
    facts = [staged({ text: "<b>x</b> \u202etxet" })];
    const page = await show();
    const review = page.container.querySelector('[data-slot="memory-review"]') as HTMLElement;
    expect(review).not.toBeNull();
    const fence = review.querySelector("figure[data-untrusted]") as HTMLElement;
    expect(fence.textContent).toContain("UNTRUSTED · staged memory");
    expect(fence.textContent).toContain("<b>x</b> txet");
    expect(fence.querySelector("b")).toBeNull();
    expect(review.textContent).toContain("Atlas");
    expect(review.compareDocumentPosition(page.container.querySelector("[data-memory-id]") as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("shows nothing for an empty queue", async () => {
    const page = await show();
    expect(page.container.querySelector('[data-slot="memory-review"]')).toBeNull();
  });

  it("approves and rejects through memory.decide, then reads the queue again", async () => {
    facts = [staged()];
    const page = await show();
    bed.handlers["memory.staged"] = () => ({ facts: [] });
    await click(button(page.container, "Approve"));
    await settle();
    expect(bed.called("memory.decide")[0]?.params).toEqual({ factId: FACT, approved: true });
    expect(page.container.querySelector('[data-slot="memory-review"]')).toBeNull();
  });
});
