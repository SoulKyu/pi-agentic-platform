// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { frenchSpacing } from "../../i18n/fr-spacing.ts";
import { setLocale } from "../../i18n/index.ts";
import { click, mount, text } from "../../testing/dom.ts";
import { ResourceFields, type ResourceDraft } from "./ResourceFields.tsx";

const DRAFT: ResourceDraft = { memoryMb: "1024", cpus: "2", diskMb: "8192" };

const show = (draft: ResourceDraft, setAlwaysOn = vi.fn(), alwaysOn = false) =>
  mount(
    <ResourceFields
      draft={draft}
      errors={{}}
      legend="VM"
      set={() => {}}
      alwaysOn={alwaysOn}
      setAlwaysOn={setAlwaysOn}
    />,
  );
const toggle = () => document.querySelector<HTMLElement>('fieldset [role="switch"]') as HTMLElement;

afterEach(() => setLocale("en"));

describe("ResourceFields: always on", () => {
  it("ends the fieldset with a switch labelled Always on", async () => {
    await show(DRAFT);
    const fieldset = document.querySelector("fieldset") as HTMLElement;
    expect(fieldset.lastElementChild?.querySelector('[role="switch"]')).toBe(toggle());
    const label = document.getElementById(toggle().getAttribute("aria-labelledby") ?? "");
    expect(label?.textContent).toBe("Always on");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("says what the reservation costs, in the memory draft plus the VM overhead", async () => {
    await show(DRAFT);
    expect(text(document.body)).toContain(
      "Never stops on its own; pap starts it again when pap starts. Keeps 1.5 GB of shared memory reserved at all times.",
    );
  });

  it("speaks French", async () => {
    setLocale("fr");
    await show(DRAFT);
    expect(text(document.body)).toContain(
      frenchSpacing(
        "Ne s'arrête jamais d'elle-même ; pap la rallume à son démarrage. Garde 1,5 Go de mémoire partagée réservés en permanence.",
      ),
    );
  });

  it("says only the first sentence while the memory draft is not a number", async () => {
    await show({ ...DRAFT, memoryMb: "abc" });
    const body = text(document.body);
    expect(body).toContain("Never stops on its own; pap starts it again when pap starts.");
    expect(body).not.toContain("Keeps");
  });

  it.each(["-2000", "1.5", "0"])(
    "says only the first sentence for the invalid memory %s",
    async (memoryMb) => {
      await show({ ...DRAFT, memoryMb });
      expect(text(document.body)).not.toContain("Keeps");
    },
  );

  it("puts a note about the fields before the switch, so the switch still ends the fieldset", async () => {
    await mount(
      <ResourceFields
        draft={DRAFT}
        errors={{}}
        legend="VM"
        set={() => {}}
        alwaysOn={false}
        setAlwaysOn={() => {}}
        note="About the fields."
      />,
    );
    const fieldset = document.querySelector("fieldset") as HTMLElement;
    const note = [...fieldset.querySelectorAll("p")].find((p) => p.textContent === "About the fields.");
    expect(note).toBeDefined();
    expect(fieldset.lastElementChild?.querySelector('[role="switch"]')).toBe(toggle());
    expect(note?.compareDocumentPosition(toggle()) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("calls setAlwaysOn(true) on a click", async () => {
    const setAlwaysOn = vi.fn();
    await show(DRAFT, setAlwaysOn);
    await click(toggle());
    expect(setAlwaysOn).toHaveBeenCalledWith(true);
  });
});
