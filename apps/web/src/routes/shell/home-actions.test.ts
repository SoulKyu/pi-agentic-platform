import { beforeEach, describe, expect, it, vi } from "vitest";
import { pathOfItem } from "../../features/workspace/index.ts";
import { type CommandHandler, registerCommand } from "../../lib/command-registry.ts";
import { useAddProjectRequest } from "../../stores/add-project-request.ts";
import { useNewLaneRequest } from "../../stores/new-lane-request.ts";
import { type PaletteSearch, usePaletteRequest } from "../../stores/palette-request.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import { homeActions } from "./home-actions.ts";
import type { Navigate } from "./tab-actions.ts";

const navigate = vi.fn(() => Promise.resolve());
const actions = () => homeActions(navigate as unknown as Navigate);
let registered: Array<() => void> = [];
const handle = (id: string, handler: CommandHandler = () => {}) => {
  const spy = vi.fn(handler);
  registered.push(registerCommand(id, spy));
  return spy;
};

beforeEach(() => {
  registered.forEach((unregister) => unregister());
  registered = [];
  navigate.mockClear();
  usePaletteRequest.setState({ search: null });
  useNewLaneRequest.setState({ prefill: null });
  useTriggerPrefill.setState({ items: {} });
  useAddProjectRequest.getState().close();
});

describe("the shell's home actions", () => {
  it("open targets by their URL", () => {
    expect(actions().href({ kind: "session", id: "s1" })).toBe(pathOfItem({ kind: "session", id: "s1" }));
    expect(actions().href({ kind: "settings", section: "automation" })).toBe("/settings/automation");
    actions().open({ kind: "compare", id: "0123456789abcdef" });
    expect(navigate).toHaveBeenCalledWith({ to: "/compare/0123456789abcdef" });
  });

  it("open the tree and the Inbox as the phone's sections when the phone shell registered them, else the drawers", () => {
    const tree = handle("drawer.tree.toggle");
    const inbox = handle("drawer.inbox.toggle");
    actions().openTree();
    actions().openInbox();
    const lists = handle("mobile.lists.open");
    const phoneInbox = handle("mobile.inbox.open");
    actions().openTree();
    actions().openInbox();
    expect([tree, inbox, lists, phoneInbox].map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  it("ask the palette for a project's transcript search, and drop the ask when no palette answers", () => {
    actions().openSearch("p1");
    expect(usePaletteRequest.getState().search).toBeNull();
    let seen: PaletteSearch | null = null;
    handle("palette.toggle", () => {
      seen = usePaletteRequest.getState().take();
    });
    actions().openSearch("p1");
    expect(seen).toEqual({ projectId: "p1" });
  });

  it("hand the lane prefill to the dialog's host, and take it back when no host answers", () => {
    const prefill = { projectRoot: "/w/api", title: "T", text: "d", models: [null] };
    expect(actions().newLane(prefill)).toBe(false);
    expect(useNewLaneRequest.getState().prefill).toBeNull();
    handle("lanes.new");
    expect(actions().newLane(prefill)).toBe(true);
    expect(useNewLaneRequest.getState().prefill).toEqual(prefill);
  });

  it("leave the trigger prefill for the project's new editor, then open it", () => {
    actions().newTrigger("p1", { name: "n", prompt: "p" });
    expect(useTriggerPrefill.getState().peek("p1")).toEqual({ name: "n", prompt: "p" });
    expect(navigate).toHaveBeenCalledWith({ to: pathOfItem({ kind: "trigger", id: "new:p1" }) });
  });

  it("ask for the Add project dialog with the continuation, and run the shortcuts help", () => {
    const onAdded = vi.fn();
    actions().addProject(onAdded);
    expect(useAddProjectRequest.getState()).toMatchObject({ open: true, onAdded });
    const help = handle("shortcuts.help");
    actions().openShortcuts();
    expect(help).toHaveBeenCalledOnce();
  });
});
