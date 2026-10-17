// @vitest-environment happy-dom
import type { LanePreview } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { alerts, button, click, field, hasButton, press, settle } from "../../testing/dom.ts";
import { current } from "./lanes-bed.tsx";
import { body, calls, choose, open, preview, resetCalls, say, select, sha } from "./new-lane-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(resetCalls);

describe("new lane dialog: models and fan-out", () => {
  it("lists the enabled models and Pi's default for each lane", async () => {
    await open();
    await press(select("Model of lane 1"), { key: "Enter" });
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull(), {
      timeout: 2000,
    });
    const options = [...document.querySelectorAll('[role="option"]')].map((node) => node.textContent);
    expect(options).toEqual(["Pi's default", "Sonnet"]);
  });

  it("each added lane adds a model row, up to four", async () => {
    await open();
    expect(body()).toContain("1 lane");
    expect(body()).toContain("(up to 4 models)");
    for (let n = 2; n <= 4; n++) {
      await click(button(document.body, "Add a model"));
      expect(select(`Model of lane ${n}`)).toBeDefined();
    }
    expect(body()).toContain("4 lanes");
    expect(button(document.body, "Add a model").disabled).toBe(true);
    await click(button(document.body, "Remove lane 4"));
    expect(body()).toContain("3 lanes");
  });

  it("a fan-out sends one model per lane and hands over the group", async () => {
    const { bed } = await open();
    bed.handlers["lanes.create"] = () => ({ laneIds: ["a-1a2b", "b-1a2b"], fanoutId: "0123456789abcdef" });
    await say("Issue or description", "Fix");
    await choose("Model of lane 1", "Sonnet");
    await click(button(document.body, "Add a model"));
    await click(button(document.body, "Create lane"));
    await settle();
    expect(bed.called("lanes.create")[0]?.params).toMatchObject({
      models: [{ provider: "anthropic", modelId: "sonnet" }, null],
    });
    expect(calls.created).toHaveBeenCalledWith({
      laneIds: ["a-1a2b", "b-1a2b"],
      fanoutId: "0123456789abcdef",
    });
  });
});

describe("new lane dialog: script approval", () => {
  const scripts = (extra: Partial<LanePreview["config"]["scripts"][number]> = {}) => [
    {
      kind: "setup" as const,
      text: "pnpm install && make seed",
      sha256: sha("a"),
      approved: false,
      previous: "pnpm install",
      ...extra,
    },
  ];
  const withScripts = (list = scripts()) => preview({ config: { ...preview().config, scripts: list } });

  it("shows nothing when every script is approved", async () => {
    await open(withScripts(scripts({ approved: true, previous: null })));
    expect(document.querySelector('[data-slot="script-trust"]')).toBeNull();
    expect(hasButton(document.body, "Approve script")).toBe(false);
  });

  it("shows a new script in a dashed box that names what it reaches", async () => {
    await open(withScripts(scripts({ previous: null })));
    const box = document.querySelector('[data-slot="script-trust"]') as HTMLElement;
    expect(box.className).toContain("border-dashed");
    expect(box.textContent).toContain("Setup script · new");
    expect(box.textContent).toContain("pnpm install && make seed");
    expect(box.textContent).toContain(
      "Runs as you in the lane, with your tools and the network: agents' shells run in a sandbox, lane scripts do not. It can read your files, keys included. pap keeps your SSH agent and tokens, among others, out of its environment. It runs when you start it, and for a fan-out's tests, once after each lane's first run.",
    );
  });

  it("shows the old and the new text side by side for a changed script", async () => {
    await open(withScripts());
    const box = document.querySelector('[data-slot="script-trust"]') as HTMLElement;
    expect(box.textContent).toContain("Setup script · changed since you approved it");
    const sides = [...box.querySelectorAll("pre")].map((node) => node.textContent);
    expect(sides).toEqual(["pnpm install", "pnpm install && make seed"]);
  });

  it("Approve runs the step-up runner, then approves the hashes it showed, then reads the project again", async () => {
    const { bed } = await open(withScripts());
    bed.handlers["lanes.approveScripts"] = () => ({ ok: true });
    await click(button(document.body, "Approve script"));
    await settle();
    expect(calls.stepUp).toHaveBeenCalledTimes(1);
    const call = bed.called("lanes.approveScripts")[0];
    expect(call?.params).toEqual({ projectRoot: "/w/proj", scripts: [{ kind: "setup", sha256: sha("a") }] });
    expect(call?.options?.commandId).toBe("step-cmd-1");
    expect(bed.called("lanes.preview")).toHaveLength(2);
  });

  it("a cancelled step-up approves nothing", async () => {
    calls.stepUp = vi.fn(async () => null);
    const { bed } = await open(withScripts());
    await click(button(document.body, "Approve script"));
    await settle();
    expect(bed.called("lanes.approveScripts")).toHaveLength(0);
  });

  it("a changed answer says so and reloads the preview", async () => {
    const { bed } = await open(withScripts());
    bed.handlers["lanes.approveScripts"] = () => ({ ok: false, reason: "changed" });
    await click(button(document.body, "Approve script"));
    await settle();
    expect(alerts(document.body).join(" ")).toContain("The script changed while you read it.");
    expect(bed.called("lanes.preview")).toHaveLength(2);
  });

  it("Create without approving sends no approval", async () => {
    const { bed } = await open(withScripts());
    await say("Issue or description", "Fix");
    await click(button(document.body, "Create lane"));
    await settle();
    expect(bed.called("lanes.approveScripts")).toHaveLength(0);
    expect(calls.stepUp).not.toHaveBeenCalled();
    expect(bed.called("lanes.create")).toHaveLength(1);
  });
});

describe("new lane dialog: the home's prefill (decision 85)", () => {
  it("opens with the home's title, its description and a model row per preset slot", async () => {
    await open(preview(), undefined, {
      text: "Keep the API",
      title: "Replace the cache",
      models: [null, null],
    });
    expect(field(document.body, "Title").value).toBe("Replace the cache");
    expect(field(document.body, "Issue or description").value).toBe("Keep the API");
    expect(select("Model of lane 2")).toBeDefined();
  });
});
