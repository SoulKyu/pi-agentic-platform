// @vitest-environment happy-dom
import { type ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { alerts, mount, settle, text, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { SessionScreen } from "./SessionScreen.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
    useNavigate: () => () => Promise.resolve(),
  };
});

const cause = (container: ParentNode) => container.querySelector("[data-crash-cause]")?.textContent;

let bed: ReturnType<typeof fakeRuntime>;
let page: Mounted | null = null;

async function show() {
  page = await mount(<SessionScreen sessionId="sess-1" />);
  await settle();
  return page.container;
}
async function emit(event: unknown) {
  bed.emit(event);
  await settle();
}

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  useSessionStore.setState({ views: {} });
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  setLocale("en");
});

describe("SessionScreen server texts (R128)", () => {
  it("shows a coded cause and a coded notice in French, and follows a locale switch", async () => {
    setLocale("fr");
    const container = await show();
    await emit({
      kind: "status",
      status: "cold",
      cause: "Agent process exited with code 70.",
      causeCode: "process_exit_code",
      causeParams: { code: "70" },
    });
    await emit({ kind: "notice", level: "warning", text: "An extension failed.", code: "extension_failed" });
    expect(cause(container)).toBe("Le processus de l'agent s'est arrêté avec le code 70.");
    expect(text(container)).toContain("Une extension a échoué.");
    expect(text(container)).not.toContain("An extension failed.");
    await act(async () => setLocale("en"));
    expect(cause(container)).toBe("Agent process exited with code 70.");
  });

  it("sends an event with no code through the pattern fallback", async () => {
    setLocale("fr");
    const container = await show();
    await emit({
      kind: "status",
      status: "cold",
      cause: "Agent process killed (SIGKILL), possibly out of memory.",
    });
    expect(cause(container)).toBe("Le processus de l'agent a été tué (SIGKILL), peut-être faute de mémoire.");
  });

  it("shows the English text as sent for an unknown code, and an extension's own text untouched", async () => {
    setLocale("fr");
    const container = await show();
    await emit({ kind: "notice", level: "error", text: "Brand new sentence.", code: "from_the_future" });
    await emit({ kind: "notice", level: "warning", text: "An extension failed.", source: "extension" });
    expect(alerts(container)).toEqual(["Brand new sentence."]);
    expect(text(container)).toContain("An extension failed.");
  });

  it("keeps an extension's notice as its own text even when it carries a code, and renders markup in params as text", async () => {
    setLocale("fr");
    const container = await show();
    await emit({
      kind: "notice",
      level: "warning",
      text: "My own words.",
      source: "extension",
      code: "extension_failed",
    });
    await emit({
      kind: "notice",
      level: "warning",
      text: "t",
      code: "extension_failed_during",
      params: { event: "<b>x</b>" },
    });
    expect(text(container)).toContain("My own words.");
    expect(text(container)).not.toContain("Une extension a échoué.");
    expect(container.querySelector("[data-notice] b")).toBeNull();
    expect(text(container)).toContain("Une extension a échoué pendant <b>x</b>.");
  });
});
