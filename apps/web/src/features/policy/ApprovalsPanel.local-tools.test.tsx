// @vitest-environment happy-dom
import { DEFAULT_POLICY_SETTINGS } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsApprovalsEn, settingsApprovalsFr } from "../../i18n/catalog/settings-approvals.ts";
import { registerCatalog, setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, field, mount, settle, text, typeInto, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ApprovalsPanel } from "./ApprovalsPanel.tsx";

registerCatalog({ en: settingsApprovalsEn, fr: settingsApprovalsFr });

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const TODO = { tool: "todo", source: "/x/ext/todo.ts" };
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

async function show(stored: unknown = null, revision = 4) {
  bed.handlers["policy.getSettings"] = () => ({ value: stored, revision });
  bed.handlers["policy.setSettings"] = () => ({ revision: revision + 1 });
  page = await mount(<ApprovalsPanel />);
  await settle();
  return page.container;
}
const setCalls = () => bed.called("policy.setSettings");
const rows = (container: HTMLElement) => [...container.querySelectorAll("[data-local-tool]")];
const leave = async (input: HTMLElement) => {
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
};
const declare = async (container: HTMLElement, tool: string, source: string) => {
  await typeInto(field(container, "Tool name"), tool);
  await typeInto(field(container, "Source path"), source);
};

describe("Settings › Approvals › Local tools (decision 117, A2)", () => {
  it("adds a rule, saves it with the revision it read, then removes it and saves again", async () => {
    const container = await show();
    expect(text(container)).toContain("No local tool declared.");
    expect(button(container, "Add local tool").disabled).toBe(true);
    await declare(container, TODO.tool, TODO.source);
    await click(button(container, "Add local tool"));
    expect(rows(container)).toHaveLength(1);
    expect(text(container)).toContain(`${TODO.tool} · ${TODO.source}`);
    expect(field(container, "Tool name").value).toBe("");
    await click(button(container, "Save"));
    await settle();
    expect(setCalls()[0]?.params).toMatchObject({ value: { localTools: [TODO] }, baseRevision: 4 });
    await click(button(container, "Remove todo"));
    expect(rows(container)).toHaveLength(0);
    await click(button(container, "Save"));
    await settle();
    expect(setCalls()[1]?.params).toMatchObject({ value: { localTools: [] }, baseRevision: 5 });
  });

  it("lists the stored rules and sends them back unchanged with another edit", async () => {
    const container = await show({ ...DEFAULT_POLICY_SETTINGS, localTools: [TODO] });
    expect(rows(container)).toHaveLength(1);
    await typeInto(field(container, "Blocked commands"), "sudo *");
    await click(button(container, "Save"));
    await settle();
    expect(setCalls()[0]?.params).toMatchObject({ value: { localTools: [TODO], denylist: ["sudo *"] } });
  });

  it("opens with a document stored before the field existed", async () => {
    const container = await show({ defaultMode: "supervised", builtinDenylist: true, denylist: [] });
    expect(rows(container)).toHaveLength(0);
  });

  it("shows each error under its own field, only after the field was left, and refuses a duplicate", async () => {
    const container = await show({ ...DEFAULT_POLICY_SETTINGS, localTools: [TODO] });
    await declare(container, "to do", "/x/\u202e/todo.ts");
    expect(text(container)).not.toContain("A tool name is letters, digits");
    expect(text(container)).not.toContain("The source is one line");
    await leave(field(container, "Tool name"));
    expect(text(container)).toContain("A tool name is letters, digits");
    expect(text(container)).not.toContain("The source is one line");
    await leave(field(container, "Source path"));
    expect(text(container)).toContain("The source is one line of visible characters");
    expect(button(container, "Add local tool").disabled).toBe(true);
    await declare(container, TODO.tool, TODO.source);
    expect(text(container)).toContain("This tool and source are already listed.");
    expect(button(container, "Add local tool").disabled).toBe(true);
  });

  it("trims the name and the source before adding", async () => {
    const container = await show();
    await declare(container, "  todo ", " /x/ext/todo.ts  ");
    await click(button(container, "Add local tool"));
    await click(button(container, "Save"));
    await settle();
    expect(setCalls()[0]?.params).toMatchObject({ value: { localTools: [TODO] } });
  });

  it("keeps Save disabled, with a hint, while a local tool is typed and not added", async () => {
    const container = await show();
    await declare(container, "todo", "");
    expect(button(container, "Save").disabled).toBe(true);
    expect(text(container)).toContain("Add the local tool you typed, or clear its fields, to save.");
    await declare(container, "", "");
    expect(button(container, "Save").disabled).toBe(false);
    expect(text(container)).not.toContain("Add the local tool you typed");
  });

  it("disables Add with its reason when the list is full", async () => {
    const full = Array.from({ length: 64 }, (_, i) => ({ tool: `t${i}`, source: `/x/${i}.ts` }));
    const container = await show({ ...DEFAULT_POLICY_SETTINGS, localTools: full });
    await declare(container, "todo", TODO.source);
    expect(button(container, "Add local tool").disabled).toBe(true);
    expect(text(container)).toContain("The list is full (64 local tools).");
  });

  it("states what a local tool is and what a rule cannot change, in English and in French", async () => {
    const container = await show();
    expect(text(container)).toContain(
      "A local tool reads nothing from outside this machine, sends nothing outside and does not modify your files.",
    );
    expect(text(container)).toContain(
      "its calls run without asking, in every mode including Read only, even after external content",
    );
    expect(text(container)).toContain("has no effect");
    setLocale("fr");
    await settle();
    expect(text(container)).toContain(
      "Un outil local ne lit rien hors de cette machine, n'envoie rien à l'extérieur et ne modifie pas vos fichiers.",
    );
    expect(text(container)).toContain(
      "s'exécutent sans demander, dans tous les modes, y compris Lecture seule, même après du contenu externe",
    );
    expect(text(container)).toContain("La source est le chemin d'enregistrement exact de l'outil.");
    expect(text(container)).not.toContain("tel que pap l'affiche");
    expect(text(container)).not.toMatch(/approvals\./);
  });
});
