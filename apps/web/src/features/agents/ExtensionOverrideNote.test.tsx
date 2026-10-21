// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { mount, text } from "../../testing/dom.ts";
import { ExtensionOverrideNote } from "./ExtensionOverrideNote.tsx";
import "./register-space-catalog.ts";

const notice = (code: string, level: "info" | "error") => ({
  kind: "notice",
  level,
  text: "x",
  code,
});
const note = () => document.querySelector("[data-extension-override]");

beforeEach(() => {
  setLocale("en");
  useSessionStore.setState({ views: {} });
});

describe("the status panel's line about overridden tools", () => {
  it("shows one neutral line when the thread's session saw an override, in the viewer's language", async () => {
    useSessionStore.getState().apply("s1", notice("extension_override", "info"));
    useSessionStore.getState().apply("s1", notice("extension_override", "info"));
    const page = await mount(<ExtensionOverrideNote sessionId="s1" />);
    expect(document.querySelectorAll("[data-extension-override]")).toHaveLength(1);
    expect(text(page.container)).toContain("pap's tool is the one in use");
    expect(note()?.className).toContain("text-muted");
    expect(note()?.className).not.toContain("text-err");
    expect(note()?.getAttribute("role")).toBeNull();
  });

  it("is French when the locale is", async () => {
    setLocale("fr");
    useSessionStore.getState().apply("s1", notice("extension_override", "info"));
    const page = await mount(<ExtensionOverrideNote sessionId="s1" />);
    expect(text(page.container)).toContain("l'outil de pap est celui utilisé");
  });

  it("shows nothing for a real failure, another session, or no thread yet", async () => {
    useSessionStore.getState().apply("s1", notice("extension_failed_named", "error"));
    useSessionStore.getState().apply("s2", notice("extension_override", "info"));
    await mount(
      <>
        <ExtensionOverrideNote sessionId="s1" />
        <ExtensionOverrideNote sessionId={null} />
      </>,
    );
    expect(note()).toBeNull();
  });
});
