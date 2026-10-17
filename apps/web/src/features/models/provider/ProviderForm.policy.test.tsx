// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsProvidersEn as en } from "../../../i18n/catalog/settings-providers.ts";
import { button, click, field, settle, text, typeInto } from "../../../testing/dom.ts";
import { current, formBed, showForm } from "./provider-models-bed.tsx";

// The policy is one constant of @pap/contracts: the form reads it at render time, and this file flips it.
const policy = vi.hoisted(() => ({ value: "loopback" as "loopback" | "any" }));
vi.mock("@pap/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pap/contracts")>();
  return new Proxy(actual, {
    get: (target, key) => (key === "HTTP_PLAINTEXT_POLICY" ? policy.value : Reflect.get(target, key)),
  });
});
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  policy.value = "loopback";
});

async function customForm() {
  formBed();
  const { page } = await showForm();
  await settle();
  await click(button(page.container, "Custom"));
  return page;
}

describe("the policy sentence follows HTTP_PLAINTEXT_POLICY", () => {
  it("loopback: the this-machine sentence, no clear-text warning", async () => {
    policy.value = "loopback";
    const page = await customForm();
    await typeInto(field(page.container, "Base URL") as HTMLInputElement, "http://192.168.1.50:11434/v1");
    const body = text(page.container);
    expect(body).toContain(en["settingsProviders.url.policy.loopback"]);
    expect(body).not.toContain(en["settingsProviders.url.policy.any"]);
    expect(body).not.toContain(en["settingsProviders.url.clearText"]);
  });

  it("any: the any-host sentence, and the clear-text warning once a key is attached", async () => {
    policy.value = "any";
    const page = await customForm();
    await typeInto(field(page.container, "Base URL") as HTMLInputElement, "http://192.168.1.50:11434/v1");
    const body = text(page.container);
    expect(body).toContain(en["settingsProviders.url.policy.any"]);
    expect(body).not.toContain(en["settingsProviders.url.policy.loopback"]);
    expect(body).toContain(en["settingsProviders.url.clearText"]);
    await click(button(page.container, "No key"));
    expect(text(page.container)).not.toContain(en["settingsProviders.url.clearText"]);
  });

  it("any: a secret header alone raises the warning (carry: keyTravelsInClear counts headers)", async () => {
    policy.value = "any";
    const page = await customForm();
    await typeInto(field(page.container, "Base URL") as HTMLInputElement, "http://192.168.1.50:11434/v1");
    await click(button(page.container, "No key"));
    await click(button(page.container, "Add a header"));
    await typeInto(field(page.container, "Header name") as HTMLInputElement, "X-Api-Key");
    await typeInto(field(page.container, "Header variable name") as HTMLInputElement, "TEAM_KEY");
    expect(text(page.container)).toContain(en["settingsProviders.url.clearText"]);
  });
});
