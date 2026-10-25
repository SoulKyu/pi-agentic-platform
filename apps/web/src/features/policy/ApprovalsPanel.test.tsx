// @vitest-environment happy-dom
import { DEFAULT_POLICY_SETTINGS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsApprovalsEn, settingsApprovalsFr } from "../../i18n/catalog/settings-approvals.ts";
import { registerCatalog, setLocale, translate } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import {
  alerts,
  statuses,
  button,
  click,
  field,
  mount,
  settle,
  text,
  typeInto,
  type Mounted,
} from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ApprovalsPanel } from "./ApprovalsPanel.tsx";
import { BUILTIN_IDS, BUILTIN_RESIDUALS } from "./policy-settings.vm.ts";

registerCatalog({ en: settingsApprovalsEn, fr: settingsApprovalsFr });

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed = fakeRuntime();
let page: Mounted | null = null;
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  setLocale("en");
});

/** The answers of a method in order; the last one repeats. An Error is thrown instead of returned. */
function answers(method: string, list: unknown[]) {
  let index = 0;
  bed.handlers[method] = () => {
    const next = list[Math.min(index++, list.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
}
const deferred = () => {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
};
const show = async () => {
  page = await mount(<ApprovalsPanel />);
  await settle();
  return page.container;
};
const radios = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLInputElement>('[role="radiogroup"] input[type="radio"]'),
];
/** The mode radio whose own name (not its description) is this. */
const radioNamed = (container: HTMLElement, name: string) => {
  const found = radios(container).find(
    (radio) => document.getElementById(radio.getAttribute("aria-labelledby") ?? "")?.textContent === name,
  );
  if (!found) throw new Error(`no mode ${name}`);
  return found;
};
const mode = async (container: HTMLElement, name: string) => {
  await click(radioNamed(container, name));
};
const checkedMode = (container: HTMLElement) =>
  document.getElementById(
    radios(container)
      .find((radio) => radio.checked)
      ?.getAttribute("aria-labelledby") ?? "",
  )?.textContent;
/** The switch whose visible label is this. */
const toggle = (container: HTMLElement, label: string) => {
  const found = [...container.querySelectorAll('[role="switch"]')].find(
    (el) => document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent === label,
  );
  if (!found) throw new Error(`no switch ${label}`);
  return found as HTMLElement;
};
const blocked = (container: HTMLElement) => field(container, "Blocked commands");
const setCalls = () => bed.called("policy.setSettings");

describe("Settings › Approvals", () => {
  it("saves the edited settings with the revision it read, and keeps the edits on a conflict", async () => {
    answers("policy.getSettings", [
      { value: null, revision: 0 },
      { value: { ...DEFAULT_POLICY_SETTINGS, denylist: ["x *"] }, revision: 2 },
    ]);
    answers("policy.setSettings", [new RpcError("conflict"), { revision: 3 }]);
    const container = await show();
    await mode(container, "Ask for everything");
    await typeInto(blocked(container), "sudo *");
    await click(button(container, "Save"));
    await settle();
    expect(setCalls()[0]).toMatchObject({
      params: {
        value: { ...DEFAULT_POLICY_SETTINGS, defaultMode: "supervised", denylist: ["sudo *"] },
        baseRevision: 0,
      },
      options: { commandId: "bed-cmd-00000001" },
    });
    expect(text(container)).toContain(
      "These settings changed elsewhere. Your changes are still here: save again to keep them.",
    );
    expect(blocked(container).value).toBe("sudo *");
    expect(bed.called("policy.getSettings")).toHaveLength(2);
    await click(button(container, "Save"));
    await settle();
    expect(setCalls()[1]).toMatchObject({
      params: { baseRevision: 2 },
      options: { commandId: "bed-cmd-00000002" },
    });
    expect(text(container)).toContain("Saved.");
    expect(text(container)).not.toContain("changed elsewhere");
  });

  it("disables Save while a line is invalid, and says which", async () => {
    answers("policy.getSettings", [{ value: null, revision: 0 }]);
    const container = await show();
    await typeInto(blocked(container), "ok\nbad\u0000line");
    expect(text(container)).toContain("Line 2 is not a valid pattern");
    expect(button(container, "Save").disabled).toBe(true);
    await typeInto(blocked(container), "ok\nbad line");
    expect(button(container, "Save").disabled).toBe(false);
    expect(setCalls()).toHaveLength(0);
  });

  it("refuses more lines than the limit and says which line goes over", async () => {
    answers("policy.getSettings", [{ value: null, revision: 0 }]);
    const container = await show();
    await typeInto(blocked(container), Array.from({ length: 65 }, (_, i) => `p${i}`).join("\n"));
    expect(text(container)).toContain("Line 65 is over the limit of 64 patterns.");
    expect(button(container, "Save").disabled).toBe(true);
  });

  it("lists the first lines with a problem and counts the others", async () => {
    answers("policy.getSettings", [{ value: null, revision: 0 }]);
    const container = await show();
    await typeInto(blocked(container), Array.from({ length: 8 }, () => "a\u0000b").join("\n"));
    expect(text(container)).toContain("Line 5 is not a valid pattern");
    expect(text(container)).not.toContain("Line 6 is not");
    expect(text(container)).toContain("3 more lines have a problem.");
  });

  it("sends the host list only while its switch is on, and an empty list blocks every URL", async () => {
    answers("policy.getSettings", [{ value: null, revision: 0 }]);
    answers("policy.setSettings", [{ revision: 1 }]);
    const container = await show();
    expect(() => field(container, "Allowed hosts")).toThrow();
    await click(toggle(container, "Only let tools reach these hosts"));
    expect(text(container)).toContain("With no host listed, every URL is blocked.");
    await typeInto(field(container, "Allowed hosts"), "Example.com");
    expect(text(container)).toContain("Line 1 is not a valid host name");
    expect(button(container, "Save").disabled).toBe(true);
    await typeInto(field(container, "Allowed hosts"), "");
    await click(button(container, "Save"));
    await settle();
    expect(setCalls()[0]?.params).toMatchObject({ value: { allowHosts: [] } });
  });

  it("states the limits the owner accepted, in English and in French", async () => {
    answers("policy.getSettings", [{ value: null, revision: 0 }]);
    const container = await show();
    expect(text(container)).not.toContain("A shell command is limited only by the blocked-command list");
    await mode(container, "Full access");
    expect(text(container)).toContain("A shell command is limited only by the blocked-command list");
    expect(text(container)).toContain("In full access, a shell command is limited only by this list.");
    expect(text(container)).toContain("is asked about (Deny / Allow once), not blocked");
    expect(text(container)).toContain("It cannot see an address a script builds");
    expect(text(container)).toContain("Off by default.");
    expect(text(container)).toContain("proxies set in the environment or in config files, saved git aliases");
    expect(text(container)).toContain("hosts built at run time");
    for (const id of BUILTIN_IDS) expect(container.querySelector(`[data-builtin="${id}"]`)).not.toBeNull();
    for (const id of BUILTIN_RESIDUALS)
      expect(container.querySelector(`[data-residual="${id}"]`)).not.toBeNull();
    expect(text(container)).toContain("What it cannot catch");
    setLocale("fr");
    await settle();
    expect(text(container)).toContain(
      "Une commande shell n'est limitée que par la liste des commandes bloquées",
    );
    expect(text(container)).toContain("Elle ne voit pas une adresse qu'un script construit");
    expect(text(container)).toContain("Désactivé par défaut.");
    expect(text(container)).not.toMatch(/approvals\./);
  });

  it("gives every mode, builtin line and residual a French and an English text", () => {
    for (const mode of ["read-only", "supervised", "auto-accept-edits", "full-access"] as const) {
      expect(translate("fr", `approvals.mode.${mode}`)).not.toBe(translate("en", `approvals.mode.${mode}`));
      expect(translate("en", `approvals.mode.${mode}.hint`)).not.toMatch(/^approvals\./);
    }
    for (const id of BUILTIN_IDS)
      expect(translate("fr", `approvals.builtin.${id}`)).not.toMatch(/^approvals\./);
    for (const id of BUILTIN_RESIDUALS)
      expect(translate("fr", `approvals.cannot.${id}`)).not.toMatch(/^approvals\./);
  });

  it("lists the four modes as one labelled radio group with every description visible (M7R123)", async () => {
    answers("policy.getSettings", [{ value: null, revision: 0 }]);
    const container = await show();
    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-label")).toBe("Mode of new sessions");
    const all = radios(container);
    expect(all).toHaveLength(4);
    expect(new Set(all.map((radio) => radio.name)).size).toBe(1);
    expect(checkedMode(container)).toBe("Auto-accept edits");
    for (const hint of [
      "Reads run. Edits, commands and network calls are refused.",
      "Reads run. Edits, commands and network calls ask first.",
      "Reads and edits in the project run. Commands and network calls ask first.",
      "Everything runs without asking.",
    ])
      expect(text(group as HTMLElement)).toContain(hint);
    for (const radio of all)
      expect(document.getElementById(radio.getAttribute("aria-describedby") ?? "")?.textContent).toMatch(
        /\./,
      );
    expect(text(group as HTMLElement)).not.toContain("pap still asks before writes outside the project");
    await mode(container, "Full access");
    expect(text(group as HTMLElement)).toContain("pap still asks before writes outside the project");
    expect(checkedMode(container)).toBe("Full access");
  });

  it("switches read-only commands off and sends readOnlyCommands: false (M7R125)", async () => {
    answers("policy.getSettings", [{ value: null, revision: 0 }]);
    answers("policy.setSettings", [{ revision: 1 }]);
    const container = await show();
    const control = toggle(container, "Run read-only commands without asking");
    expect(control.getAttribute("aria-checked")).toBe("true");
    for (const name of ["cat", "rg", "git status", "git log"])
      expect(container.querySelector(`[data-read-only-command="${name}"]`)).not.toBeNull();
    expect(text(container)).toContain("pap cannot check commands while Pi runs a shell command prefix");
    expect(text(container)).toContain("only in their read-only forms");
    await click(control);
    expect(text(container)).not.toContain("pap cannot check commands");
    await click(button(container, "Save"));
    await settle();
    expect(setCalls()[0]?.params).toMatchObject({ value: { readOnlyCommands: false } });
  });

  it("keeps a stored readOnlyCommands: false when something else is saved", async () => {
    answers("policy.getSettings", [
      { value: { ...DEFAULT_POLICY_SETTINGS, readOnlyCommands: false }, revision: 1 },
    ]);
    answers("policy.setSettings", [{ revision: 2 }]);
    const container = await show();
    expect(toggle(container, "Run read-only commands without asking").getAttribute("aria-checked")).toBe(
      "false",
    );
    await mode(container, "Read only");
    await click(button(container, "Save"));
    await settle();
    expect(setCalls()[0]?.params).toMatchObject({
      value: { readOnlyCommands: false, defaultMode: "read-only" },
    });
  });

  it("says the read-only commands copy in French", async () => {
    answers("policy.getSettings", [{ value: null, revision: 0 }]);
    const container = await show();
    setLocale("fr");
    await settle();
    expect(text(container)).toContain("Exécuter sans demander les commandes en lecture seule");
    expect(text(container)).toContain("pap ne peut pas vérifier les commandes");
    expect(text(container)).toContain("dans leurs formes en lecture seule");
    expect(text(container)).not.toMatch(/approvals\./);
  });

  it("cannot double-send a save", async () => {
    answers("policy.getSettings", [{ value: null, revision: 0 }]);
    const reply = deferred();
    bed.handlers["policy.setSettings"] = () => reply.promise;
    const container = await show();
    const save = button(container, "Save");
    await click(save);
    await click(save);
    expect(setCalls()).toHaveLength(1);
    expect(save.disabled).toBe(true);
    reply.resolve({ revision: 1 });
    await settle();
    expect(save.disabled).toBe(false);
  });

  it("re-reads after a timeout: a write that went through is saved, one that did not is shown", async () => {
    const wanted = { ...DEFAULT_POLICY_SETTINGS, denylist: ["sudo *"] };
    answers("policy.getSettings", [
      { value: null, revision: 0 },
      { value: wanted, revision: 1 },
    ]);
    answers("policy.setSettings", [new RpcError("timeout")]);
    const container = await show();
    await typeInto(blocked(container), "sudo *");
    await click(button(container, "Save"));
    await settle();
    expect(setCalls()).toHaveLength(1);
    expect(bed.called("policy.getSettings")).toHaveLength(2);
    expect(text(container)).toContain("Saved.");
    expect(alerts(container)).toEqual([]);

    answers("policy.getSettings", [{ value: null, revision: 1 }]);
    await typeInto(blocked(container), "sudo *\nrm *");
    await click(button(container, "Save"));
    await settle();
    expect(setCalls()).toHaveLength(2); // never sent again by itself
    expect(alerts(container)).toHaveLength(1);
    expect(alerts(container)[0]).toContain("may still have gone through");
    expect(blocked(container).value).toBe("sudo *\nrm *");
  });

  it("shows a failed save and a failed re-read, never silently", async () => {
    answers("policy.getSettings", [{ value: null, revision: 0 }]);
    answers("policy.setSettings", [new RpcError("bad_request")]);
    const container = await show();
    await click(button(container, "Save"));
    await settle();
    expect(alerts(container)).toEqual([
      "pap refused this request: a value is missing or out of range. Nothing was changed. Check the fields and try again.",
    ]);
    answers("policy.setSettings", [new RpcError("conflict")]);
    answers("policy.getSettings", [new RpcError("offline")]);
    await click(button(container, "Save"));
    await settle();
    expect(alerts(container)).toHaveLength(1);
  });

  it("shows a load failure and loads again on request", async () => {
    answers("policy.getSettings", [new RpcError("internal"), { value: null, revision: 4 }]);
    const container = await show();
    expect(statuses(container)).toHaveLength(1);
    expect(() => blocked(container)).toThrow();
    await click(button(container, "Try again"));
    await settle();
    expect(blocked(container).value).toBe("");
    expect(alerts(container)).toEqual([]);
    await click(button(container, "Save"));
    await settle();
    expect(setCalls()[0]?.params).toMatchObject({ baseRevision: 4 });
  });

  it("starts from the stored settings", async () => {
    answers("policy.getSettings", [
      {
        value: {
          ...DEFAULT_POLICY_SETTINGS,
          defaultMode: "read-only",
          denylist: ["a *", "b *"],
          allowHosts: ["x.example"],
        },
        revision: 7,
      },
    ]);
    const container = await show();
    expect(blocked(container).value).toBe("a *\nb *");
    expect(field(container, "Allowed hosts").value).toBe("x.example");
    expect(checkedMode(container)).toBe("Read only");
  });
});
