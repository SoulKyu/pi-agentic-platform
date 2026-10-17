import type { PushConfig, PushDeviceView } from "@pap/contracts";
import { createElement, type ComponentProps } from "react";
import { setLocale } from "../i18n/index.ts";
import { NotificationsPanel } from "../features/notifications/NotificationsPanel.tsx";
import { RpcError } from "../runtime/index.ts";
import { usePwa } from "../stores/pwa.ts";
import { mount, settle } from "./dom.ts";
import { fakePushEnv, manualTimers, SERVER_PUBLIC_KEY } from "./push-env.ts";
import { fakeRuntime } from "./runtime-bed.ts";

export const NOW = 1_800_000_000_000;
export const DEFAULT_DOC = {
  classes: {
    approval: true,
    failed: true,
    budget: true,
    notify: true,
    done: false,
    reply: false,
    review: false,
  },
  muteUntil: null,
  titles: "generic",
};
export const config = (over: Partial<PushConfig> = {}): PushConfig => ({
  publicKey: SERVER_PUBLIC_KEY,
  status: "on",
  reason: null,
  readiness: { status: "ready" },
  subscribed: 3,
  max: 10,
  lastFailure: null,
  keysReset: null,
  ...over,
});
export const device = (id: string, over: Partial<PushDeviceView> = {}): PushDeviceView => ({
  id,
  label: `Device ${id}`,
  host: "web.push.apple.com",
  createdAt: NOW - 86_400_000,
  lastOkAt: NOW - 120_000,
  current: false,
  ...over,
});

/** The daemon's push and settings answers, as the contracts shape them; a test changes the fields it needs. */
export function notificationsBed() {
  const bed = fakeRuntime("open");
  const s = {
    bed,
    doc: { value: null as unknown, revision: 4 },
    devices: [device("a", { current: true }), device("b"), device("c")],
    cfg: config(),
    automation: { quietHours: { from: "22:00", to: "07:00" } } as unknown,
  };
  setLocale("en");
  usePwa.setState(usePwa.getInitialState(), true);
  bed.handlers["push.config"] = () => s.cfg;
  bed.handlers["push.list"] = () => ({ items: s.devices });
  bed.handlers["settings.get"] = (params) =>
    (params as { key: string }).key === "automation"
      ? { value: s.automation, revision: 1 }
      : { value: s.doc.value, revision: s.doc.revision };
  bed.handlers["settings.set"] = (params) => {
    const body = params as { value: unknown; baseRevision: number };
    if (body.baseRevision !== s.doc.revision) throw new RpcError("conflict");
    s.doc = { value: body.value, revision: s.doc.revision + 1 };
    return { revision: s.doc.revision };
  };
  bed.handlers["push.revoke"] = (params) => {
    s.devices = s.devices.filter((one) => one.id !== (params as { id: string }).id);
    return { ok: true };
  };
  return s;
}

export async function openPanel(over: Partial<ComponentProps<typeof NotificationsPanel>> = {}) {
  const push = fakePushEnv({}, null);
  const clock = manualTimers();
  const page = await mount(
    createElement(NotificationsPanel, {
      env: push.env,
      timers: clock.timers,
      now: () => NOW,
      automationLink: (label: string) => createElement("a", { href: "/settings/automation" }, label),
      ...over,
    }),
  );
  await settle();
  return { page, push, clock };
}

/** The switch a label points at. */
export function toggle(container: ParentNode, label: string): HTMLElement {
  const found = [...container.querySelectorAll("label")].filter(
    (one) => (one.textContent ?? "").trim() === label,
  );
  if (found.length !== 1) throw new Error(`expected one switch "${label}", found ${found.length}`);
  const target = document.getElementById(found[0]?.htmlFor ?? "");
  if (!target) throw new Error(`no control for "${label}"`);
  return target;
}
