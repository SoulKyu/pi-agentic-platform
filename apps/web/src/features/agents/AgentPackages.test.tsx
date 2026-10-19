// @vitest-environment happy-dom
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, field, hasButton, mount, press, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentPackages } from "./AgentPackages.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
const current: { runtime: Runtime | undefined } = { runtime: undefined };

const plugin = (source: string, scope: "user" | "project" = "user") => ({
  source,
  scope,
  installedPath: null,
  enabled: true,
  filtered: false,
});
const seen: { system: readonly string[]; picks: readonly string[] | null } = { system: [], picks: null };

function Host({ system, picks }: { system: readonly string[]; picks: readonly string[] | null }) {
  const [state, setState] = useState({ systemPackages: system, packages: picks });
  useEffect(() => {
    seen.system = state.systemPackages;
    seen.picks = state.packages;
  });
  return (
    <AgentPackages
      systemPackages={state.systemPackages}
      packages={state.packages}
      set={(patch) => setState((previous) => ({ ...previous, ...patch }))}
    />
  );
}

async function open(system: readonly string[] = [], picks: readonly string[] | null = null) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["plugins.list"] = () => ({
    plugins: [
      plugin("npm:pi-mem0"),
      plugin("git:github.com/acme/pi-tools"),
      plugin("npm:project-only", "project"),
    ],
    truncated: false,
  });
  await mount(<Host system={system} picks={picks} />);
  await settle();
  return bed;
}
const body = () => text(document.body);
const addName = async (name: string) => {
  await typeInto(field(document.body, "Package name"), name);
  await click(button(document.body, "Add"));
};
const tick = (label: string): HTMLElement | null => {
  const row = [...document.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  return row === undefined ? null : document.getElementById(row.htmlFor);
};

beforeEach(() => setLocale("en"));

describe("system packages", () => {
  it("adds a valid Debian package name as a chip", async () => {
    await open();
    await addName("libssl-dev");
    expect(seen.system).toEqual(["libssl-dev"]);
    expect(body()).toContain("libssl-dev");
    expect((field(document.body, "Package name") as HTMLInputElement).value).toBe("");
  });

  it("adds on Enter without submitting the form around it", async () => {
    await open();
    await typeInto(field(document.body, "Package name"), "git");
    const event = await press(field(document.body, "Package name"), { key: "Enter", cancelable: true });
    expect(event.defaultPrevented).toBe(true);
    expect(seen.system).toEqual(["git"]);
  });

  it.each(["Git", "-dash", "a b", "x".repeat(64), "pkg;rm", ""])(
    "shows the field error for %j and does not add it",
    async (name) => {
      await open();
      await addName(name);
      expect(seen.system).toEqual([]);
      expect(body()).toContain("Not a Debian package name");
    },
  );

  it("refuses a package twice", async () => {
    await open(["git"]);
    await addName("git");
    expect(seen.system).toEqual(["git"]);
    expect(body()).toContain("This package is already in the list.");
  });

  it("refuses a 65th package", async () => {
    await open(Array.from({ length: 64 }, (_, n) => `pkg${n}`));
    await addName("one-more");
    expect(seen.system).toHaveLength(64);
    expect(body()).toContain("At most 64 packages.");
  });

  it("removes a chip", async () => {
    await open(["git", "curl"]);
    await click(button(document.body, "Remove git"));
    expect(seen.system).toEqual(["curl"]);
  });
});

describe("Pi packages", () => {
  it("defaults to All, with the sources hidden", async () => {
    await open();
    expect(tick("All")?.getAttribute("aria-checked")).toBe("true");
    expect(body()).not.toContain("npm:pi-mem0");
    expect(seen.picks).toBeNull();
  });

  it("lists the user's sources once All is unticked, every one ticked", async () => {
    await open();
    await click(tick("All") as HTMLElement);
    expect(seen.picks).toEqual(["npm:pi-mem0", "git:github.com/acme/pi-tools"]);
    expect(body()).not.toContain("project-only");
    expect(tick("npm:pi-mem0")?.getAttribute("aria-checked")).toBe("true");
  });

  it("picks a subset, and All goes back to null", async () => {
    await open();
    await click(tick("All") as HTMLElement);
    await click(tick("npm:pi-mem0") as HTMLElement);
    expect(seen.picks).toEqual(["git:github.com/acme/pi-tools"]);
    await click(tick("All") as HTMLElement);
    expect(seen.picks).toBeNull();
  });

  it("keeps a saved pick the profile no longer lists, ticked", async () => {
    await open([], ["npm:gone"]);
    expect(tick("npm:gone")?.getAttribute("aria-checked")).toBe("true");
    expect(hasButton(document.body, "Add")).toBe(true);
  });

  it("says so when the profile has no package, and when the list cannot be read", async () => {
    const bed = await open([], []);
    bed.handlers["plugins.list"] = () => ({ plugins: [], truncated: false });
    document.body.replaceChildren();
    await mount(<Host system={[]} picks={[]} />);
    await settle();
    expect(body()).toContain("Your Pi profile has no package.");
    bed.handlers["plugins.list"] = () => {
      throw new Error("no");
    };
    document.body.replaceChildren();
    await mount(<Host system={[]} picks={null} />);
    await settle();
    expect(tick("All")?.getAttribute("aria-checked")).toBe("true");
  });
});
