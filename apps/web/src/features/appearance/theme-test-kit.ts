import type { CustomTheme } from "@pap/contracts";
import { act } from "react";
import { vi } from "vitest";
import { settle } from "../../testing/dom.ts";
import fixtureRoles from "./theme-fixtures.json" with { type: "json" };
import { useAppearanceStore } from "./appearance-store.ts";
import { DEFAULT_ACCOUNT, DEFAULT_DEVICE } from "./model.ts";

export const roles: CustomTheme["roles"] = fixtureRoles;
export const initial = { name: "My theme", base: "night", roles } as const;
export const exampleText = JSON.stringify(initial);
export const hostileText = JSON.stringify({
  ...initial,
  roles: { ...roles, bg: "url(https://x.test/a.png)", agent: undefined },
});
export const seed = (account = DEFAULT_ACCOUNT) =>
  useAppearanceStore.setState({
    account,
    device: DEFAULT_DEVICE,
    accountStatus: "local",
    deviceStored: true,
  });
export const themes = (count: number): CustomTheme[] =>
  Array.from({ length: count }, (_, i) => ({ id: `t${i}`, name: `Theme ${i}`, base: "night", roles }));
export const ocean: CustomTheme = { id: "ocean", name: "Ocean", base: "night", roles };

export const named = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find(
    (one) => (one.textContent ?? "").trim() === name,
  ) as HTMLButtonElement;
export const labelled = (label: string) =>
  document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
export const row = (role: string) => document.querySelector(`[data-role="${role}"]`) as HTMLElement;
export const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;
export const preview = () => document.querySelector('[data-slot="theme-preview"]') as HTMLElement;
export const dialogTitles = () =>
  [...document.querySelectorAll('[role="dialog"] h2')].map((h) => h.textContent);
export const ratioOf = (value: number) => `${(Math.floor(value * 10) / 10).toFixed(1)}:1`;

export async function chooseFile(text: string, size = text.length): Promise<void> {
  const file = { size, text: vi.fn(async () => text) };
  Object.defineProperty(fileInput(), "files", { value: [file], configurable: true });
  await act(async () => {
    fileInput().dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
