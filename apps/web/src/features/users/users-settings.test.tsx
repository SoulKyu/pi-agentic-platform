// @vitest-environment happy-dom
import type { InviteView, ProviderSharingView, UserView } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usersEn, usersFr } from "../../i18n/catalog/users.ts";
import { registerCatalog, setLocale } from "../../i18n/index.ts";
import type { StepUpRunner } from "../../lib/step-up-context.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, field, hasButton, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { UsersSettings } from "./UsersSettings.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

registerCatalog({ en: usersEn, fr: usersFr });

const user = (patch: Partial<UserView>): UserView => ({
  id: "u1",
  username: "gui",
  role: "owner",
  createdAt: 1_700_000_000_000,
  lastSeenAt: null,
  disabled: false,
  budgetUsd: null,
  spentTodayUsd: 0,
  spent7dUsd: 0,
  boxesRunning: 0,
  ...patch,
});
const OWNER = user({ spentTodayUsd: 1.5, spent7dUsd: 9 });
const ANA = user({
  id: "u2",
  username: "ana",
  role: "member",
  budgetUsd: 5,
  spentTodayUsd: 2,
  spent7dUsd: 3,
  boxesRunning: 2,
});
const BOB = user({
  id: "u3",
  username: "bob",
  role: "member",
  budgetUsd: 5,
  spentTodayUsd: 5,
  disabled: true,
});
const INVITE: InviteView = { id: "i1", nameHint: "carol", createdAt: 1, expiresAt: 1_700_086_400_000 };
const PROVIDERS: ProviderSharingView[] = [
  { provider: "openai", label: "OpenAI", auth: "api_key", shared: true, servable: true },
  { provider: "anthropic", label: "Anthropic", auth: "oauth", shared: false, servable: false },
];

const stepUp = vi.fn(async <T,>(run: (commandId: string) => Promise<T>) => run("cmd-1"));

async function open(users: UserView[] = [OWNER, ANA, BOB]) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["users.list"] = () => ({ users, invites: [INVITE] });
  bed.handlers["users.providers"] = () => ({ providers: PROVIDERS });
  const page = await mount(
    <TooltipProvider>
      <UsersSettings stepUp={stepUp as unknown as StepUpRunner} />
    </TooltipProvider>,
  );
  await settle();
  return { bed, container: page.container };
}
const body = () => text(document.body);

beforeEach(() => {
  setLocale("en");
  stepUp.mockClear();
});

describe("Settings › Users", () => {
  it("lists users with their usage and role chips", async () => {
    const { container } = await open();
    expect(body()).toContain("gui");
    expect(body()).toContain("OWNER");
    expect(body()).toContain("MEMBER");
    expect(body()).toContain("Today $2.00 of $5.00 · 7 days $3.00");
    expect(body()).toContain("2 boxes running");
    expect(body()).toContain("never");
    expect(body()).toContain("Invitation carol");
    expect(body()).toContain("PENDING");
    expect(hasButton(container, "REVOKE")).toBe(true);
    const owner = container.querySelector('[data-user="u1"]') as HTMLElement;
    expect(text(owner)).toContain("no cap");
    expect(hasButton(owner, "DISABLE")).toBe(false);
    expect(hasButton(owner, "DELETE")).toBe(false);
  });

  it("the over-budget line is err only when the spend reached the budget", async () => {
    await open();
    const line = (id: string) => document.querySelector(`[data-user="${id}"] [data-spend]`) as HTMLElement;
    expect(line("u2").className).not.toContain("text-err");
    expect(line("u3").className).toContain("text-err");
  });

  it("the invitation link is shown once and copied, after the step-up", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { bed } = await open();
    bed.handlers["users.invite"] = () => ({
      url: "https://pap.example/invite#token=SECRET",
      expiresAt: 1_700_086_400_000,
      invite: INVITE,
    });
    await click(button(document.body, "INVITE"));
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await typeInto(field(dialog, "Name hint (optional)"), "carol");
    await click(button(dialog, "INVITE"));
    await settle();
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(bed.called("users.invite")[0]?.params).toEqual({ nameHint: "carol" });
    expect(body()).toContain("It works once, until");
    expect((field(document.body, "Invitation link") as HTMLInputElement).value).toBe(
      "https://pap.example/invite#token=SECRET",
    );
    await click(button(document.body, "COPY THE LINK"));
    expect(writeText).toHaveBeenCalledWith("https://pap.example/invite#token=SECRET");
    expect(body()).toContain("Link copied.");
    await click(button(document.body, "Done"));
    await settle();
    expect(document.body.innerHTML).not.toContain("SECRET");
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain("SECRET");
  });

  it("revokes a pending invitation", async () => {
    const { bed, container } = await open();
    bed.handlers["users.revokeInvite"] = () => ({ ok: true });
    await click(button(container, "REVOKE"));
    await settle();
    expect(bed.called("users.revokeInvite")[0]?.params).toEqual({ inviteId: "i1" });
  });

  it("saves a member's budget", async () => {
    const { bed } = await open();
    bed.handlers["users.setBudget"] = () => ({ ok: true });
    const row = document.querySelector('[data-user="u2"]') as HTMLElement;
    await typeInto(field(row, "Daily budget (USD)"), "12");
    await click(button(row, "SAVE"));
    await settle();
    expect(bed.called("users.setBudget")[0]?.params).toEqual({ userId: "u2", dailyBudgetUsd: 12 });
  });

  it("delete asks the confirm then the step-up, and Cancel is never danger", async () => {
    const { bed } = await open();
    bed.handlers["users.delete"] = () => ({ ok: true });
    const row = document.querySelector('[data-user="u2"]') as HTMLElement;
    await click(button(row, "DELETE"));
    expect(stepUp).not.toHaveBeenCalled();
    expect(body()).toContain("Cost and audit records are kept.");
    const confirm = button(document.body, "DELETE ana");
    expect(confirm.className).toContain("text-err");
    expect(button(document.body, "Cancel").className).not.toContain("text-err");
    await click(confirm);
    await settle();
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(bed.called("users.delete")[0]?.params).toEqual({ userId: "u2" });
  });

  it("disable needs no step-up; enable asks the step-up", async () => {
    const { bed } = await open();
    bed.handlers["users.setDisabled"] = () => ({ ok: true });
    await click(button(document.querySelector('[data-user="u2"]') as HTMLElement, "DISABLE"));
    await settle();
    expect(stepUp).not.toHaveBeenCalled();
    expect(bed.called("users.setDisabled")[0]?.params).toEqual({ userId: "u2", disabled: true });
    await click(button(document.querySelector('[data-user="u3"]') as HTMLElement, "ENABLE"));
    await settle();
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(bed.called("users.setDisabled")[1]?.params).toEqual({ userId: "u3", disabled: false });
  });

  it("disable shows the DISABLED chip in mut", async () => {
    await open();
    const chip = [...document.querySelectorAll('[data-user="u3"] [data-slot="chip"]')].find(
      (one) => one.textContent === "DISABLED",
    );
    expect(chip?.getAttribute("data-tone")).toBe("mut");
    expect(document.querySelectorAll('[data-user="u2"] [data-slot="chip"]')).toHaveLength(1);
  });

  it("a subscription provider's switch is disabled", async () => {
    const { bed } = await open();
    bed.handlers["users.setProviderShared"] = () => ({ ok: true });
    expect(body()).toContain("Providers shared with members");
    expect(body()).toContain("Subscription login: never served to boxes.");
    const switches = [...document.querySelectorAll('[role="switch"]')] as HTMLButtonElement[];
    expect(switches).toHaveLength(2);
    expect(switches[0]?.disabled).toBe(false);
    expect(switches[1]?.disabled).toBe(true);
    await click(switches[0] as HTMLElement);
    await settle();
    expect(bed.called("users.setProviderShared")[0]?.params).toEqual({ provider: "openai", shared: false });
  });

  it("every provider switch has a unique accessible name containing its provider", async () => {
    await open();
    const names = [...document.querySelectorAll('[role="switch"]')].map((one) =>
      (one.getAttribute("aria-labelledby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
    expect(names).toEqual(["OpenAI: Shared", "Anthropic: Shared"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("speaks French", async () => {
    setLocale("fr");
    const { container } = await open();
    expect(hasButton(container, "INVITER")).toBe(true);
    expect(body()).toContain("Providers partagés avec les membres");
    expect(body()).toContain("Aujourd'hui");
  });
});
