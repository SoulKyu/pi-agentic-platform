// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { alerts, statuses, button, click, hasButton, settle, text } from "../../testing/dom.ts";
import { forgetExtensions, readExtensions } from "./extension-read.ts";
import {
  current,
  LAST_MODEL_PROVIDER,
  newBed,
  overviewOf,
  providerButton,
  show,
  switchOf,
} from "./models-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
  forgetExtensions();
});

async function open(id: string, over = overviewOf()) {
  const bed = newBed(over);
  const page = await show();
  await settle();
  await click(providerButton(page.container, id));
  return { bed, page };
}

describe("providers", () => {
  it("lists every provider with its sign-in state chip", async () => {
    newBed();
    const page = await show();
    await settle();
    const chips = (id: string) =>
      [...providerButton(page.container, id).querySelectorAll('[data-slot="chip"]')].map((chip) => [
        chip.getAttribute("data-tone"),
        chip.textContent,
      ]);
    expect(chips("openai")).toEqual([["ok", "configured"]]);
    expect(chips("anthropic")).toEqual([
      ["mut", "not configured"],
      ["ok", "env var"],
    ]);
    expect(chips("mine")).toEqual([["att", "unknown"]]);
  });

  it("says plainly that pap cannot tell when the sign-in files are unreadable (MC26)", async () => {
    const { page } = await open("mine");
    expect(text(page.container)).toContain(
      "pap could not read Pi's sign-in files, so it cannot tell whether this provider is signed in.",
    );
    expect(text(page.container)).not.toContain("Not signed in.");
  });

  it("never draws a hidden character of a provider name in the list", async () => {
    const base = overviewOf();
    newBed({
      ...base,
      providers: base.providers.map((one, at) => (at === 0 ? { ...one, name: "Evil\u202eName\u200b" } : one)),
    });
    const page = await show();
    await settle();
    expect(text(page.container)).toContain("EvilName");
    expect(text(page.container)).not.toMatch(/[\u202e\u200b]/);
  });

  it("shows the environment variable names and whether they are set, never a value (MC26)", async () => {
    const { page } = await open("anthropic");
    const body = text(page.container);
    expect(body).toContain("ANTHROPIC_API_KEY: set");
    expect(body).toContain("ANTHROPIC_OAUTH_TOKEN: not set");
    expect(body).toContain("an environment variable is not a stored sign-in");
    expect(body).toContain("Not signed in.");
  });

  it("is in French with no key left over", async () => {
    setLocale("fr");
    const { page } = await open("anthropic");
    expect(text(page.container)).toContain("ANTHROPIC_API_KEY\u202f: définie");
    expect(hasButton(page.container, "Actualiser le catalogue")).toBe(true);
    expect(text(page.container)).not.toMatch(/settingsModels\./);
  });

  it("says the list is cut and that Pi is offline", async () => {
    newBed(overviewOf({ truncated: true, offline: true }));
    const page = await show();
    await settle();
    expect(text(page.container)).toContain("The list is cut: not every provider is shown.");
    expect(text(page.container)).toContain("Pi is in offline mode: the catalog is not fetched.");
  });
});

describe("switches", () => {
  it("reads a partial provider off with its n/m count, and a full one on", async () => {
    const { page } = await open("anthropic");
    expect(switchOf(page.container, "All Anthropic models").getAttribute("aria-checked")).toBe("false");
    expect(text(page.container)).toContain("1/2 on");
    await click(providerButton(page.container, "openai"));
    expect(switchOf(page.container, "All OpenAI models").getAttribute("aria-checked")).toBe("true");
  });

  it("switches a model through models.setEnabled and reads the list again", async () => {
    const { bed, page } = await open("anthropic");
    await click(switchOf(page.container, "claude-b name"));
    await settle();
    expect(bed.called("models.setEnabled").map((call) => call.params)).toEqual([
      { op: { op: "toggle", provider: "anthropic", modelId: "claude-b", enabled: true } },
    ]);
    expect(bed.called("models.setEnabled")[0]?.options?.commandId).toBeTypeOf("string");
    expect(bed.called("models.overview")).toHaveLength(2);
  });

  it("m2.provider-page: a write on a provider page reads again the extensions read in this tab, and only then", async () => {
    const { bed, page } = await open("anthropic");
    bed.handlers["models.extensions"] = () => ({ providers: [], truncated: false, failed: false });
    await click(switchOf(page.container, "claude-b name"));
    await settle();
    expect(bed.called("models.extensions")).toEqual([]);
    readExtensions();
    await settle();
    await click(switchOf(page.container, "claude-a name"));
    await settle();
    expect(bed.called("models.extensions")).toHaveLength(2);
  });

  it("switches a whole provider", async () => {
    const { bed, page } = await open("anthropic");
    await click(switchOf(page.container, "All Anthropic models"));
    await settle();
    expect(bed.called("models.setEnabled").map((call) => call.params)).toEqual([
      { op: { op: "provider", provider: "anthropic", enabled: true } },
    ]);
  });

  it("disables a switch while its write is pending and sends nothing for a second click", async () => {
    const { bed, page } = await open("anthropic");
    let release: (value: unknown) => void = () => {};
    bed.handlers["models.setEnabled"] = () => new Promise((resolve) => (release = resolve));
    const control = switchOf(page.container, "claude-b name");
    await click(control);
    expect(control.disabled).toBe(true);
    await click(control);
    expect(bed.called("models.setEnabled")).toHaveLength(1);
    // another switch is free to go while this one waits
    expect(switchOf(page.container, "claude-a name").disabled).toBe(false);
    release({ patterns: null });
    await settle();
    expect(switchOf(page.container, "claude-b name").disabled).toBe(false);
  });

  it("shows what was asked from the click until the list read after the write is in, then the list", async () => {
    const { bed, page } = await open("anthropic");
    let write: (value: unknown) => void = () => {};
    bed.handlers["models.setEnabled"] = () => new Promise((resolve) => (write = resolve));
    const read = bed.handlers["models.overview"];
    let reread: () => void = () => {};
    bed.handlers["models.overview"] = (params) =>
      new Promise((resolve) => (reread = () => resolve(read?.(params))));
    const checked = () => switchOf(page.container, "claude-b name").getAttribute("aria-checked");
    await click(switchOf(page.container, "claude-b name"));
    expect(checked()).toBe("true");
    write({ patterns: null });
    await settle();
    expect(bed.called("models.overview")).toHaveLength(2);
    expect(checked()).toBe("true");
    // This fake daemon's list never changes: once it is in, it wins over what was asked.
    reread();
    await settle();
    expect(checked()).toBe("false");
  });

  it("reads the providers again once, after the last of several parallel writes", async () => {
    const { bed, page } = await open("anthropic");
    const release: Array<(value: unknown) => void> = [];
    bed.handlers["models.setEnabled"] = () => new Promise((resolve) => release.push(resolve));
    await click(switchOf(page.container, "claude-b name"));
    await click(switchOf(page.container, "claude-a name"));
    release[0]?.({ patterns: null });
    await settle();
    expect(bed.called("models.overview")).toHaveLength(1);
    release[1]?.({ patterns: null });
    await settle();
    expect(bed.called("models.overview")).toHaveLength(2);
  });

  it("shows the capacity refusal once and does not send the write again", async () => {
    const { bed, page } = await open("anthropic");
    bed.handlers["models.setEnabled"] = () => {
      throw new RpcError("capacity");
    };
    await click(switchOf(page.container, "claude-b name"));
    await settle();
    expect(alerts(page.container)).toEqual(["Too many changes are waiting. Wait a moment, then try again."]);
    expect(bed.called("models.setEnabled")).toHaveLength(1);
  });

  it("shows the last-model note when the server refuses to switch the last model off", async () => {
    const { bed, page } = await open("openai", overviewOf({ providers: [LAST_MODEL_PROVIDER] }));
    bed.handlers["models.setEnabled"] = () => {
      throw new RpcError("conflict");
    };
    await click(switchOf(page.container, "gpt-a name"));
    await settle();
    expect(alerts(page.container)).toEqual([
      "At least one model must stay on. Switch another model on first.",
    ]);
  });

  it("says the outcome is unknown after a timeout, and does not retry it", async () => {
    const { bed, page } = await open("anthropic");
    bed.handlers["models.setEnabled"] = () => {
      throw new RpcError("timeout");
    };
    await click(switchOf(page.container, "claude-b name"));
    await settle();
    expect(alerts(page.container)[0]).toContain("pap did not hear back.");
    expect(bed.called("models.setEnabled")).toHaveLength(1);
  });

  it("makes every switch and star read-only in a project scope and says where to change it", async () => {
    const { bed, page } = await open(
      "openai",
      overviewOf({
        enabled: {
          patterns: ["openai/*"],
          scope: "project",
          settingsPath: "/p/.pi/settings.json",
          warnings: [],
        },
      }),
    );
    expect(switchOf(page.container, "All OpenAI models").disabled).toBe(true);
    expect(switchOf(page.container, "gpt-b name").disabled).toBe(true);
    expect(button(page.container, "Make gpt-b name the default").disabled).toBe(true);
    expect(text(page.container)).toContain("Change it there: /p/.pi/settings.json");
    await click(switchOf(page.container, "gpt-b name"));
    expect(bed.called("models.setEnabled")).toEqual([]);
  });
});

describe("defaults and catalog", () => {
  it("shows the default model and marks its star", async () => {
    const { page } = await open("openai");
    expect(text(page.container)).toContain("gpt-a from openai");
    expect(text(page.container)).toContain("Reasoning level: high");
    expect(button(page.container, "Make gpt-a name the default").getAttribute("aria-pressed")).toBe("true");
    expect(button(page.container, "Make gpt-b name the default").getAttribute("aria-pressed")).toBe("false");
  });

  it("sets the default through models.setDefault, and only for a model that is on", async () => {
    const { bed, page } = await open("openai");
    await click(button(page.container, "Make gpt-b name the default"));
    await settle();
    expect(bed.called("models.setDefault").map((call) => call.params)).toEqual([
      { provider: "openai", modelId: "gpt-b" },
    ]);
    await click(providerButton(page.container, "anthropic"));
    expect(button(page.container, "Make claude-b name the default").disabled).toBe(true);
    expect(text(page.container)).toContain("Only a model that is switched on can be the default.");
  });

  it("refreshes the catalog and says what happened, naming the providers that did not answer", async () => {
    const { bed, page } = await open("openai");
    bed.handlers["models.refreshCatalog"] = () => ({
      changed: true,
      offline: false,
      failedProviders: ["x", "y"],
    });
    await click(button(page.container, "Refresh catalog"));
    await settle();
    expect(bed.called("models.refreshCatalog")).toHaveLength(1);
    expect(text(page.container)).toContain("These providers did not answer: x, y.");
    expect(bed.called("models.overview")).toHaveLength(2);
  });

  it("reports an offline refresh as not fetched", async () => {
    const { bed, page } = await open("openai");
    bed.handlers["models.refreshCatalog"] = () => ({ changed: false, offline: true, failedProviders: [] });
    await click(button(page.container, "Refresh catalog"));
    await settle();
    expect(text(page.container)).toContain("Pi is in offline mode: the catalog was not fetched.");
  });

  it("shows a failed overview with a retry", async () => {
    const bed = newBed();
    bed.handlers["models.overview"] = () => {
      throw new RpcError("helper_failed");
    };
    const page = await show();
    await settle();
    expect(statuses(page.container)).toHaveLength(1);
    bed.handlers["models.overview"] = () => overviewOf();
    await click(button(page.container, "Try again"));
    await settle();
    expect(providerButton(page.container, "openai")).not.toBeNull();
  });
});
