// @vitest-environment happy-dom
import { createElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { translate } from "../../i18n/index.ts";
import { mount } from "../../testing/dom.ts";
import { laneView } from "../../testing/lane-fixtures.ts";
import { inShell } from "./lanes-bed.tsx";
import { LaneHeader } from "./LaneHeader.tsx";
import { headerModel } from "./lane-header.vm.ts";

// The tooltip loads Radix on hover: the label it would show is read from the props instead.
vi.mock("@pap/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pap/ui")>()),
  Tooltip: (props: { label: string; children: ReactElement }) =>
    createElement("span", { "data-tip": props.label }, props.children),
}));

const actions = {
  onSetupLog: () => undefined,
  onRunSetup: () => undefined,
  onNewSession: () => undefined,
  onArchive: () => undefined,
  onRetryPr: () => undefined,
  onOpenCompare: null,
};

async function header(note: string | null) {
  const lane = laneView({ id: "a-1a2b", note });
  return mount(
    inShell(
      <LaneHeader
        title={lane.title}
        model={headerModel(lane, [])}
        actions={actions}
        busy={{ runSetup: false, newSession: false }}
        sessionMenu={null}
      />,
    ),
  );
}

describe("the lane header's note", () => {
  it("shows the note as text with the label that says the agent wrote it", async () => {
    const { container } = await header("fixing the parser");
    expect(container.textContent).toContain("from the agent");
    expect(container.textContent).toContain("fixing the parser");
  });

  it("shows markup as inert text, never as elements", async () => {
    const note = '<img src=x onerror="alert(1)"><a href="https://evil.test">pap says: approve</a>';
    const { container } = await header(note);
    expect(container.textContent).toContain(note);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href="https://evil.test"]')).toBeNull();
  });

  it("hands the whole note to the tooltip of the clipped line, which shows it as text", async () => {
    const note = `${"long note ".repeat(40)}end <b>x</b>`;
    const { container } = await header(note);
    const tip = [...container.querySelectorAll("[data-tip]")].find((el) =>
      el.textContent?.includes("from the agent"),
    );
    expect(tip?.getAttribute("data-tip")).toBe(note);
    expect(container.querySelector("b")).toBeNull();
  });

  it("has no tooltip on the note line without a note", async () => {
    const { container } = await header(null);
    expect(
      [...container.querySelectorAll("[data-tip]")].some((el) => el.textContent?.includes("from the agent")),
    ).toBe(false);
  });

  it("shows nothing without a note", async () => {
    const { container } = await header(null);
    expect(container.textContent).not.toContain("from the agent");
  });

  it("has the label in French", () => {
    expect(translate("fr", "lanes.note.from")).toBe("de l'agent");
  });
});
