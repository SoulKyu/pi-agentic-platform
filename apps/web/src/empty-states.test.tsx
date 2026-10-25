// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentOf,
  current as automationBed,
  newBed,
  showWithStepUp,
} from "./features/automation/board-bed.tsx";
import { AgentColumn } from "./features/automation/AgentColumn.tsx";
import { DevicesList } from "./features/notifications/DevicesList.tsx";
import { agentSafetyEn, agentSafetyFr } from "./i18n/catalog/agent-safety.ts";
import { automationEn, automationFr } from "./i18n/catalog/automation.ts";
import { automationTriggerEn, automationTriggerFr } from "./i18n/catalog/automation-trigger.ts";
import { notificationsEn, notificationsFr } from "./i18n/catalog/notifications.ts";
import { settingsAccessEn, settingsAccessFr } from "./i18n/catalog/settings-access.ts";
import { settingsAppearanceEn, settingsAppearanceFr } from "./i18n/catalog/settings-appearance.ts";
import { registerCatalog } from "./i18n/index.ts";
import { fakeRuntime } from "./testing/runtime-bed.ts";
import { mount, settle, type Mounted } from "./testing/dom.ts";
import type { Runtime } from "./runtime/index.ts";
import { TokensPanel } from "./features/auth/TokensPanel.tsx";

registerCatalog({ en: settingsAccessEn, fr: settingsAccessFr });
registerCatalog({ en: notificationsEn, fr: notificationsFr });

vi.mock("./features/auth/auth-api.ts", () => ({ confirmPassword: vi.fn() }));
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("./runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime/index.ts")>()),
  getRuntime: () => current.runtime ?? automationBed.runtime,
}));

let page: Mounted | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
});

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean);

describe("first-use empty states say what the list is for", () => {
  it("each catalog value is a state plus a sentence of purpose, in both languages", () => {
    const sets: [string, Record<string, string>, Record<string, string>][] = [
      ["automation.column.empty", automationEn, automationFr],
      ["automation.journal.empty", automationTriggerEn, automationTriggerFr],
      ["access.tokens.empty", settingsAccessEn, settingsAccessFr],
      ["agentSafety.secrets.empty", agentSafetyEn, agentSafetyFr],
      ["notifications.devices.empty", notificationsEn, notificationsFr],
      ["settings.theme.empty", settingsAppearanceEn, settingsAppearanceFr],
    ];
    for (const [key, en, fr] of sets) {
      expect(sentences(en[key] ?? "").length, `${key} en`).toBeGreaterThanOrEqual(2);
      expect(sentences(fr[key] ?? "").length, `${key} fr`).toBeGreaterThanOrEqual(2);
    }
  });

  it("DevicesList with no rows shows its sentence", async () => {
    page = await mount(<DevicesList rows={[]} now={0} busy={false} onRevoke={() => {}} />);
    expect(page.container.textContent).toContain(
      "No device is registered yet. Turn on notifications in this browser or on your phone to get an alert when an agent needs you.",
    );
  });

  it("AgentColumn with no task shows its sentence", async () => {
    newBed();
    page = await showWithStepUp(
      <AgentColumn
        column={{ agent: agentOf("atlas-1a2b", "Atlas"), triggers: [], tasks: [], running: 0 }}
        now={0}
        currentTaskId={null}
        avatarStyle="outlined"
        onOpenSession={() => {}}
        onOpenTrigger={() => {}}
        onNewTrigger={() => {}}
      />,
    );
    expect(page.container.textContent).toContain("No tasks yet. A trigger adds one here each time it fires.");
  });

  it("TokensPanel with no tokens is an EmptyState with a title and its purpose", async () => {
    const bed = fakeRuntime();
    current.runtime = bed.runtime;
    bed.handlers["auth.tokens.list"] = () => ({ tokens: [], now: 0 });
    page = await mount(<TokensPanel onSignedOut={vi.fn()} />);
    await settle();
    const empty = page.container.querySelector('[data-slot="empty-state"]');
    expect(empty?.querySelector("h3")?.textContent).toBe("No tokens yet");
    expect(empty?.querySelector("p")?.textContent).toBe(
      "No tokens yet. A token lets a script or another machine call pap with the permissions you choose.",
    );
  });
});
