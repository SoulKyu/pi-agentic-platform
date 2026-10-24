// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { button, click, hasButton, text } from "../../testing/dom.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { current, itemOf, newBed, NOW, show } from "./inbox-bed.tsx";
import { InboxRow } from "./InboxRow.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const paused = itemOf({
  id: "i9",
  kind: "box_paused",
  toHandle: false,
  taskId: null,
  sessionId: null,
  agentId: null,
  triggerName: "notes",
  costUsd: null,
  detail: "Its box crashed 3 times in 10 minutes. Start it again from the project page.",
});

const row = (onOpenProject = vi.fn()) =>
  show(
    <ul>
      <InboxRow
        item={paused}
        now={NOW}
        avatarStyle="outlined"
        onPick={vi.fn()}
        onOpenProject={onOpenProject}
      />
    </ul>,
  );

beforeEach(() => {
  newBed();
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([], { projects: [boxProject("stopped")] }));
});
afterEach(() => setLocale("en"));

describe("a paused box in the Inbox (R7)", () => {
  it("is a project item: title, project name, detail and a link, never an agent row", async () => {
    const onOpenProject = vi.fn();
    const page = await row(onOpenProject);
    const content = text(page.container);
    expect(content).toContain("Project box paused after 3 crashes");
    expect(content).toContain("notes");
    expect(content).toContain("Its box crashed 3 times in 10 minutes.");
    expect(content).not.toContain("Someone");
    await click(button(page.container, "Open project notes"));
    expect(onOpenProject).toHaveBeenCalledExactlyOnceWith("b1");
  });

  it("has no link when the project is gone", async () => {
    useShellStore.getState().reset();
    const page = await row();
    expect(text(page.container)).toContain("notes");
    expect(hasButton(page.container, "Open project notes")).toBe(false);
  });

  it("says its title in French", async () => {
    setLocale("fr");
    const page = await row();
    expect(text(page.container)).toContain("Box du projet en pause après 3 plantages");
  });
});
