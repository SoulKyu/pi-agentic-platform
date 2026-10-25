// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { button, click, mount, settle, text, type Mounted } from "../../testing/dom.ts";
import { segmentedGroup } from "../../testing/names.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { SubagentsSettings } from "./SubagentsSettings.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
let page: Mounted | null = null;
const stored = (value: unknown, revision = 3) => {
  bed.handlers["settings.get"] = () => ({ value, revision });
};
const profiles = (list: unknown[], extra: Record<string, unknown> = {}) => {
  bed.handlers["subagents.profiles"] = () => ({
    profiles: list,
    truncated: false,
    skipped: { parse: 0, refused: 0, tooLarge: 0 },
    ...extra,
  });
};
const show = async () => {
  page = await mount(
    <TooltipProvider>
      <SubagentsSettings />
    </TooltipProvider>,
  );
  await settle();
  return page.container;
};
const saved = () => bed.called("settings.set").map((call) => call.params);

beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([shellSession({ id: "s1", updatedAt: 5 })]));
  profiles([]);
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("Settings › Agents › Subagents (M11R155)", () => {
  it("shows the defaults when nothing is stored: on, two at once", async () => {
    stored(null, 0);
    const view = await show();
    expect(view.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect(segmentedGroup(view, "Subagents at once")?.querySelector('[data-state="on"]')?.textContent).toBe(
      "2",
    );
  });

  it("reads the stored values", async () => {
    stored({ subagents: { enabled: false, maxConcurrent: 4 } });
    const view = await show();
    expect(view.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(segmentedGroup(view, "Subagents at once")?.querySelector('[data-state="on"]')?.textContent).toBe(
      "4",
    );
  });

  it("offers 1 to 4 and nothing else", async () => {
    stored(null, 0);
    const view = await show();
    const items = [...(segmentedGroup(view, "Subagents at once")?.querySelectorAll("button") ?? [])].map(
      (b) => b.textContent,
    );
    expect(items).toEqual(["1", "2", "3", "4"]);
  });

  it("saves the switch with the revision it read, keeping the new-agent defaults of the same document", async () => {
    stored(
      {
        newAgent: { sandbox: { required: false, network: true } },
        subagents: { enabled: true, maxConcurrent: 3 },
      },
      7,
    );
    const view = await show();
    await click(view.querySelector('[role="switch"]') as HTMLElement);
    await settle();
    expect(saved()).toEqual([
      {
        key: "agents",
        value: {
          newAgent: { sandbox: { required: false, network: true } },
          subagents: { enabled: false, maxConcurrent: 3 },
        },
        baseRevision: 7,
      },
    ]);
  });

  it("saves a new concurrency, then the next change from the revision the save returned", async () => {
    stored(null, 0);
    bed.handlers["settings.set"] = (params) => ({
      revision: (params as { baseRevision: number }).baseRevision + 1,
    });
    const view = await show();
    await click(button(view, "4"));
    await settle();
    await click(button(view, "1"));
    await settle();
    expect(saved().map((one) => (one as { baseRevision: number }).baseRevision)).toEqual([0, 1]);
    expect(
      saved().map(
        (one) => (one as { value: { subagents: { maxConcurrent: number } } }).value.subagents.maxConcurrent,
      ),
    ).toEqual([4, 1]);
  });

  it("says a conflict, reads the document again and does not keep the refused value", async () => {
    stored(null, 1);
    bed.handlers["settings.set"] = () => {
      throw new RpcError("conflict");
    };
    const view = await show();
    stored({ subagents: { enabled: true, maxConcurrent: 3 } }, 2);
    await click(button(view, "4"));
    await settle();
    expect(view.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
    expect(segmentedGroup(view, "Subagents at once")?.querySelector('[data-state="on"]')?.textContent).toBe(
      "3",
    );
  });

  it("does not offer the controls while the document is unreadable, and says so", async () => {
    bed.handlers["settings.get"] = () => {
      throw new RpcError("internal");
    };
    const view = await show();
    expect(view.querySelector('[role="switch"]')).toBeNull();
    expect(view.querySelector('[data-slot="inline-error"][role="status"]')).not.toBeNull();
  });

  it("lists the profiles read-only: name, description, source", async () => {
    stored(null, 0);
    profiles([
      { name: "scout", description: "Fast recon", source: "user" },
      { name: "planner", description: "<b>Plans</b>", source: "project" },
    ]);
    const view = await show();
    const rows = [...view.querySelectorAll("[data-profile]")];
    expect(rows.map((row) => row.querySelector("[data-profile-name]")?.textContent)).toEqual([
      "scout",
      "planner",
    ]);
    expect(rows[0]?.textContent).toContain("Fast recon");
    expect(rows[0]?.textContent).toContain("User");
    expect(rows[1]?.textContent).toContain("Project");
    expect(rows[1]?.querySelector("b")).toBeNull();
    expect(text(view)).toContain("Edit the file in Pi's agents folder.");
    expect(view.querySelectorAll("[data-profile] input, [data-profile] button")).toHaveLength(0);
    expect(bed.called("subagents.profiles").map((call) => call.params)).toEqual([{ sessionId: "s1" }]);
  });

  it("cleans a description: no hidden characters, clipped", async () => {
    stored(null, 0);
    profiles([{ name: "scout", description: `A\u202eB${"z".repeat(600)}`, source: "project" }]);
    const view = await show();
    const description = view.querySelector("[data-profile] p")?.textContent ?? "";
    expect(description.startsWith("AB")).toBe(true);
    expect(description).not.toContain("\u202e");
    expect(description.length).toBeLessThanOrEqual(300);
  });

  it("says there are no profiles, and that the list is cut when it is", async () => {
    stored(null, 0);
    const none = await show();
    expect(text(none)).toContain("No profile yet.");
    await page?.unmount();
    profiles([{ name: "scout", description: "d", source: "user" }], { truncated: true });
    const cut = await show();
    expect(text(cut)).toContain("The list is cut");
  });

  it("asks for a session when the owner has none, and reads nothing", async () => {
    stored(null, 0);
    useShellStore.getState().reset();
    const view = await show();
    expect(text(view)).toContain("Open a session to list the profiles.");
    expect(bed.called("subagents.profiles")).toEqual([]);
  });

  it("says when the profiles cannot be read, and keeps the setting usable", async () => {
    stored(null, 0);
    bed.handlers["subagents.profiles"] = () => {
      throw new RpcError("helper_failed");
    };
    const view = await show();
    expect(text(view)).toContain("The profiles could not be read.");
    expect(view.querySelector('[role="switch"]')).not.toBeNull();
  });

  it("speaks French with vous", async () => {
    setLocale("fr");
    stored(null, 0);
    const view = await show();
    expect(text(view)).toContain("Sous-agents");
    expect(text(view)).toContain("Modifiez le fichier dans le dossier agents de Pi.");
  });
});
