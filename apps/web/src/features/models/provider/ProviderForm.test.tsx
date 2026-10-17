// @vitest-environment happy-dom
import { BASE_URL_TABLE, HTTP_PLAINTEXT_POLICY } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsProvidersEn } from "../../../i18n/catalog/settings-providers.ts";
import { setLocale } from "../../../i18n/index.ts";
import { alerts, button, click, field, hasButton, settle, text, typeInto } from "../../../testing/dom.ts";
import {
  CUSTOM,
  current,
  editableMine,
  formBed,
  MINE,
  OLLAMA,
  openNew,
  pick,
  showForm,
} from "./provider-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  setLocale("en");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const en = settingsProvidersEn;
const pressed = (container: ParentNode, name: string) =>
  [...container.querySelectorAll("button")]
    .find((one) => one.textContent === name)
    ?.getAttribute("data-state");

describe("preset cards", () => {
  it("shows the eight cards first and no field yet", async () => {
    const { page } = await openNew();
    for (const name of [
      OLLAMA,
      "LM Studio (this machine)",
      "vLLM (this machine)",
      "OpenRouter",
      "OpenAI-compatible server",
      "Anthropic-compatible server",
      "Gemini-compatible server",
      CUSTOM,
    ])
      expect(hasButton(page.container, name), name).toBe(true);
    expect(page.container.querySelector("input")).toBeNull();
  });

  it("picking Ollama prefills the form and sets the auth to none", async () => {
    const { page } = await openNew();
    await pick(page.container, OLLAMA);
    expect(field(page.container, "Base URL").value).toBe("http://localhost:11434/v1");
    expect(field(page.container, "Identifier").value).toBe("ollama");
    expect(field(page.container, "Name").value).toBe("Ollama");
    expect(pressed(page.container, "No key")).toBe("on");
    expect(text(page.container)).toContain(en["settingsProviders.auth.none.note"]);
  });

  it("a hosted preset keeps the stored key and tells the key comes after saving", async () => {
    const { page } = await openNew();
    await pick(page.container, "OpenRouter");
    expect(field(page.container, "Base URL").value).toBe("https://openrouter.ai/api/v1");
    expect(text(page.container)).toContain(en["settingsProviders.auth.stored.note"]);
  });
});

describe("form.has-no-password-input (MP-RT-10)", () => {
  const clean = (container: ParentNode) => {
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(container.querySelectorAll('[autocomplete="new-password"]')).toHaveLength(0);
    expect(container.querySelectorAll('[name="api-key"]')).toHaveLength(0);
  };

  it("has none for stored, env and none while creating", async () => {
    const { page } = await openNew();
    await pick(page.container, CUSTOM);
    clean(page.container);
    await click(button(page.container, "Environment variable"));
    expect(field(page.container, "Variable name")).toBeTruthy();
    clean(page.container);
    await click(button(page.container, "No key"));
    clean(page.container);
    await click(button(page.container, "Stored key"));
    clean(page.container);
  });

  it("has none for a kept auth and a kept header while editing", async () => {
    formBed(() => editableMine({ provider: { ...MINE, auth: { kind: "keep" } } }));
    const { page } = await showForm({ id: "mine" });
    await settle();
    clean(page.container);
    expect(text(page.container)).toContain(en["settingsProviders.auth.keep.note"]);
  });
});

describe("base URL policy", () => {
  it("shows the sentence of HTTP_PLAINTEXT_POLICY as visible text, not a tooltip", async () => {
    const { page } = await openNew();
    await pick(page.container, CUSTOM);
    const shipped =
      HTTP_PLAINTEXT_POLICY === "loopback"
        ? en["settingsProviders.url.policy.loopback"]
        : en["settingsProviders.url.policy.any"];
    const other =
      HTTP_PLAINTEXT_POLICY === "loopback"
        ? en["settingsProviders.url.policy.any"]
        : en["settingsProviders.url.policy.loopback"];
    expect(text(page.container)).toContain(shipped);
    expect(text(page.container)).not.toContain(other);
    expect(page.container.querySelector("[title]")).toBeNull();
  });

  it("says why a URL is refused in words, according to the shipped column of BASE_URL_TABLE", async () => {
    const { page } = await openNew();
    await pick(page.container, CUSTOM);
    const row = BASE_URL_TABLE.find(([url]) => url === "http://192.168.1.50:11434/v1");
    const verdict = HTTP_PLAINTEXT_POLICY === "loopback" ? row?.[1] : row?.[2];
    await typeInto(field(page.container, "Base URL") as HTMLInputElement, "http://192.168.1.50:11434/v1");
    expect(alerts(page.container).includes(en["settingsProviders.problem.baseUrl.host"])).toBe(
      verdict === "host",
    );
    await typeInto(field(page.container, "Base URL") as HTMLInputElement, "https://user:pw@api.example.com");
    expect(alerts(page.container)).toContain(en["settingsProviders.problem.baseUrl.credentials"]);
  });

  it("warns that a key travels in clear only under the any policy, with a secret attached", async () => {
    const { page } = await openNew();
    await pick(page.container, CUSTOM);
    await typeInto(field(page.container, "Base URL") as HTMLInputElement, "http://192.168.1.50:11434/v1");
    expect(text(page.container).includes(en["settingsProviders.url.clearText"])).toBe(
      HTTP_PLAINTEXT_POLICY === "any",
    );
  });
});

describe("headers", () => {
  it("a credential-named header row offers only an environment variable, with the reason", async () => {
    const { page } = await openNew();
    await pick(page.container, CUSTOM);
    await click(button(page.container, "Add a header"));
    await typeInto(field(page.container, "Header name") as HTMLInputElement, "X-Api-Key");
    expect(text(page.container)).toContain(en["settingsProviders.headers.credentialReason"]);
    expect(() => field(page.container, "Value")).toThrow();
    expect(field(page.container, "Header variable name")).toBeTruthy();
    const lock = page.container.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(lock.getAttribute("aria-checked")).toBe("true");
    expect(lock.disabled).toBe(true);
  });

  it("a literal with $ shows the use-an-environment-variable reason", async () => {
    const { page } = await openNew();
    await pick(page.container, CUSTOM);
    await click(button(page.container, "Add a header"));
    await typeInto(field(page.container, "Header name") as HTMLInputElement, "X-Team");
    await typeInto(field(page.container, "Value") as HTMLInputElement, "a$b");
    expect(alerts(page.container)).toContain(en["settingsProviders.problem.headers.dollar"]);
  });

  it("adds at most eight headers", async () => {
    const { page } = await openNew();
    await pick(page.container, CUSTOM);
    for (let i = 0; i < 8; i += 1) await click(button(page.container, "Add a header"));
    expect(hasButton(page.container, "Add a header")).toBe(false);
  });
});
