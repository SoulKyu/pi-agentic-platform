// @vitest-environment happy-dom
import type { FontFamilyView } from "@pap/contracts";
import { Toaster, TooltipProvider } from "@pap/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsAppearanceEn, settingsAppearanceFr } from "../../i18n/catalog/settings-appearance.ts";
import { registerCatalog, setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { click, mount, press, settle, text } from "../../testing/dom.ts";
import { useAppearanceStore } from "./appearance-store.ts";
import { startAppearance, syncAccountAppearance } from "./controller.ts";
import { DetailsSection } from "./DetailsSection.tsx";
import { DEFAULT_ACCOUNT, DEFAULT_DEVICE } from "./model.ts";
import { useFontsStore } from "./fonts-store.ts";

registerCatalog({ en: settingsAppearanceEn, fr: settingsAppearanceFr });
vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

// happy-dom would fetch a linked stylesheet from localhost: no test touches a network.
const noCssLoading = () => {
  const settings = (
    window as unknown as {
      happyDOM: { settings: { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } };
    }
  ).happyDOM.settings;
  settings.disableCSSFileLoading = true;
  settings.handleDisabledFileLoadingAsSuccess = true;
};

const view = (slug: string, family: string): FontFamilyView => ({
  slug,
  family,
  files: 2,
  bytes: 2048,
  addedAt: 1,
});
let bed: ReturnType<typeof fakeRuntime>;
let server: FontFamilyView[];
const root = document.documentElement;

beforeEach(() => {
  noCssLoading();
  setLocale("en");
  localStorage.clear();
  document.head.innerHTML = "";
  root.removeAttribute("style");
  server = [view("inter", "Inter")];
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["fonts.list"] = () => ({ families: server });
  bed.handlers["fonts.add"] = (params) => {
    const family = (params as { family: string }).family;
    const added = view(family.toLowerCase().replace(/ /g, "-"), family);
    server = [...server, added];
    return added;
  };
  bed.handlers["fonts.remove"] = (params) => {
    server = server.filter((entry) => entry.slug !== (params as { slug: string }).slug);
    return { ok: true };
  };
  useFontsStore.setState({ families: null });
  useAppearanceStore.setState({ account: DEFAULT_ACCOUNT, device: DEFAULT_DEVICE });
});
afterEach(() => vi.useRealTimers());

const render = () =>
  mount(
    <TooltipProvider>
      <Toaster closeLabel="Close" regionLabel="Notifications" />
      <DetailsSection />
    </TooltipProvider>,
  );
const labelled = (selector: string, label: string) =>
  [...document.querySelectorAll(selector)].find((one) =>
    (one.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .some((id) => document.getElementById(id)?.textContent === label),
  ) as HTMLElement;
const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (one) => one.textContent === name || one.getAttribute("aria-label") === name,
  ) as HTMLElement;
async function options(label: string): Promise<string[]> {
  await press(labelled('[role="combobox"]', label), { key: "Enter" });
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull(), {
    timeout: 2_000,
  });
  return [...document.querySelectorAll('[role="option"]')].map((one) => one.textContent ?? "");
}
const typeFamily = async (value: string) => {
  const input = document.querySelector('input[name="font-family"]') as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};

describe("Settings > Appearance > Details > Google Fonts", () => {
  it("loads the installed families when it opens and lists them with the note", async () => {
    const page = await render();
    await settle();
    expect(bed.called("fonts.list")).toHaveLength(1);
    const content = text(page.container);
    expect(content).toContain("Google Fonts");
    expect(content).toContain("Inter");
    expect(content).toContain(
      "pap downloads the font once and serves it itself; your browser never contacts Google.",
    );
    expect(content).toContain("fonts.google.com");
    expect(document.querySelector('a[href*="google"]')).toBeNull();
  });

  it("the UI and code font selects offer the bundled choices, System and every installed family", async () => {
    await render();
    await settle();
    expect(await options("UI font")).toEqual(["Manrope", "System font", "Inter"]);
    await press(document.activeElement ?? document.body, { key: "Escape" });
    expect(await options("Code font")).toEqual(["JetBrains Mono", "System font", "Inter"]);
  });

  it("choosing a family writes custom:<slug> to the account; the controller links its css and sets the variable", async () => {
    const controller = startAppearance(window);
    await render();
    await settle();
    await options("UI font");
    await click(
      [...document.querySelectorAll('[role="option"]')].find(
        (one) => one.textContent === "Inter",
      ) as HTMLElement,
    );
    expect(useAppearanceStore.getState().account.uiFont).toBe("custom:inter");
    // the controller loads its font chunk the first time a custom font is chosen
    await vi.waitFor(() => expect(root.getAttribute("data-font-ui")).toBe("custom"), { timeout: 2_000 });
    expect(
      document.head.querySelector('link[rel="stylesheet"][href="/fonts/inter/font.css"]'),
    ).not.toBeNull();
    expect(root.style.getPropertyValue("--font-ui")).toBe('"Inter", ui-sans-serif, system-ui, sans-serif');
    controller.stop();
  });

  it("a removed family falls back to the default and the select says so, without throwing", async () => {
    useAppearanceStore.setState({ account: { ...DEFAULT_ACCOUNT, uiFont: "custom:gone" } });
    const controller = startAppearance(window);
    const page = await render();
    await settle();
    expect(root.getAttribute("data-font-ui")).toBe("default");
    expect(root.style.getPropertyValue("--font-ui")).toBe("");
    expect(document.head.querySelector("link[data-pap-font]")).toBeNull();
    expect(text(page.container)).toContain("Font removed");
    controller.stop();
  });

  it("removing the family in use drops its link and the variable", async () => {
    useAppearanceStore.setState({ account: { ...DEFAULT_ACCOUNT, uiFont: "custom:inter" } });
    const controller = startAppearance(window);
    await render();
    await settle();
    await vi.waitFor(() => expect(root.getAttribute("data-font-ui")).toBe("custom"), { timeout: 2_000 });
    expect(document.head.querySelector("link[data-pap-font]")).not.toBeNull();
    await click(buttonNamed("Remove Inter"));
    await vi.waitFor(() => expect(root.getAttribute("data-font-ui")).toBe("default"), { timeout: 2_000 });
    expect(bed.called("fonts.remove")[0]?.params).toEqual({ slug: "inter" });
    expect(document.head.querySelector("link[data-pap-font]")).toBeNull();
    expect(root.style.getPropertyValue("--font-ui")).toBe("");
    controller.stop();
  });

  it("Add sends the typed name, then lists the new family", async () => {
    const page = await render();
    await settle();
    await typeFamily("Open Sans");
    await click(buttonNamed("Add"));
    await settle();
    expect(bed.called("fonts.add")[0]?.params).toEqual({ family: "Open Sans" });
    expect(text(page.container)).toContain("Open Sans");
    expect((document.querySelector('input[name="font-family"]') as HTMLInputElement).value).toBe("");
  });

  it("refuses a name with other characters before any request", async () => {
    const page = await render();
    await settle();
    await typeFamily("Open/Sans");
    await click(buttonNamed("Add"));
    expect(bed.called("fonts.add")).toHaveLength(0);
    expect(text(page.container)).toContain("Use letters, digits and spaces only");
  });

  it("says what went wrong for each refusal of the daemon", async () => {
    const page = await render();
    await settle();
    const cases: Array<[string, string]> = [
      ["not_found", "Google Fonts has no family with this name."],
      ["network", "pap could not download this font."],
      ["limit_reached", "16 fonts are installed"],
      ["payload_too_large", "too large to install"],
      ["forbidden", "could not be added"],
    ];
    for (const [code, sentence] of cases) {
      bed.handlers["fonts.add"] = () => {
        throw new RpcError(code as never);
      };
      await typeFamily("Nope");
      await click(buttonNamed("Add"));
      await settle();
      expect(text(page.container), code).toContain(sentence);
    }
  });

  it("shows a busy state while the download runs and ignores a second click", async () => {
    let release: (view: FontFamilyView) => void = () => {};
    bed.handlers["fonts.add"] = () => new Promise<FontFamilyView>((resolve) => (release = resolve));
    await render();
    await settle();
    await typeFamily("Lato");
    await click(buttonNamed("Add"));
    await click(buttonNamed("Add"));
    expect(bed.called("fonts.add")).toHaveLength(1);
    release(view("lato", "Lato"));
    await settle();
  });

  it("reads the installed list after the socket opens only when a custom font is chosen", async () => {
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    const controller = startAppearance(window);
    await syncAccountAppearance(bed.runtime.rpc);
    expect(bed.called("fonts.list")).toHaveLength(0);
    useAppearanceStore.setState({ account: { ...DEFAULT_ACCOUNT, monoFont: "custom:inter" } });
    await syncAccountAppearance(bed.runtime.rpc);
    expect(bed.called("fonts.list")).toHaveLength(1);
    expect(useFontsStore.getState().families).toEqual(server);
    await vi.waitFor(() => expect(root.getAttribute("data-font-mono")).toBe("custom"), { timeout: 2_000 });
    expect(root.style.getPropertyValue("--font-code")).toBe(
      '"Inter", ui-monospace, SFMono-Regular, Menlo, monospace',
    );
    controller.stop();
  });

  it("keeps the default font, without throwing, when the daemon cannot list fonts", async () => {
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    bed.handlers["fonts.list"] = () => {
      throw new RpcError("unknown_method");
    };
    const controller = startAppearance(window);
    useAppearanceStore.setState({ account: { ...DEFAULT_ACCOUNT, uiFont: "custom:inter" } });
    await syncAccountAppearance(bed.runtime.rpc);
    expect(useFontsStore.getState().families).toBeNull();
    expect(root.getAttribute("data-font-ui")).toBe("default");
    controller.stop();
  });

  it("has every font key in English and in French, none empty", () => {
    const keys = Object.keys(settingsAppearanceEn).filter((key) =>
      key.startsWith("settings.appearance.fonts."),
    );
    expect(keys.length).toBeGreaterThanOrEqual(15);
    for (const key of keys) {
      expect(settingsAppearanceFr[key as keyof typeof settingsAppearanceFr], key).toBeTruthy();
    }
    expect(settingsAppearanceFr["settings.appearance.fonts.note"]).toBe(
      "pap télécharge la police une seule fois et la sert lui-même : votre navigateur ne contacte jamais Google.",
    );
  });
});
