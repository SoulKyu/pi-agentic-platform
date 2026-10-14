// @vitest-environment happy-dom
import { ERROR_CODES } from "@pap/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, text } from "../testing/dom.ts";
import { changesEn, changesFr } from "./catalog/changes.ts";
import { filesEn, filesFr } from "./catalog/files.ts";
import { sessionScreenEn, sessionScreenFr } from "./catalog/session-screen.ts";
import { settingsScreenEn, settingsScreenFr } from "./catalog/settings-screen.ts";
import { settingsAccessEn, settingsAccessFr } from "./catalog/settings-access.ts";
import { settingsAppearanceEn, settingsAppearanceFr } from "./catalog/settings-appearance.ts";
import { settingsApprovalsEn, settingsApprovalsFr } from "./catalog/settings-approvals.ts";
import { settingsShortcutsEn, settingsShortcutsFr } from "./catalog/settings-shortcuts.ts";
import { sidebarEn, sidebarFr } from "./catalog/sidebar.ts";
import { terminalEn, terminalFr } from "./catalog/terminal.ts";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import {
  CLIENT_ERROR_CODES,
  errorKey,
  getLocale,
  onLocaleChange,
  pickLocale,
  plural,
  registerCatalog,
  setLocale,
  switchLocale,
  translate,
  useT,
} from "./index.ts";

// Keys whose French is the same word (endonyms, product and font names). Every other key must differ.
const IDENTICAL_IN_FR = new Set([
  "files.viewer.source",
  "shell.surface.chat",
  "shell.surface.term",
  "shell.surface.terminal",
  "terminal.pane.title",
  "terminal.pane.titleIn",
  "terminal.surface.label",
  "commands.palette.terminal",
  "commands.palette.settings.skills",
  "settings.section.skills",
  "access.devices.browser.chrome",
  "access.devices.browser.firefox",
  "access.devices.browser.safari",
  "access.devices.browser.edge",
  "access.devices.system.linux",
  "access.devices.system.macos",
  "access.devices.system.windows",
  "access.devices.system.ios",
  "access.devices.system.android",
  "access.tokens.permissions",
  "access.tokens.domain.sessions",
  "access.tokens.domain.vcs",
  "access.tokens.count.one",
  "access.tokens.count.other",
  "app.name",
  "audit.kind.session",
  "audit.kind.audit",
  "audit.argsLabel",
  "audit.decision.info",
  "ui.notifications",
  "app.tagline",
  "settings.nav.section",
  "shell.tab.session",
  "shell.rail.label",
  "shell.mobile.sections",
  "shell.mobile.agents",
  "shell.top.tree",
  "settings.language.en",
  "settings.language.fr",
  "settings.appearance.fontManrope",
  "settings.theme.role.surface",
  "settings.theme.role.agent",
  "settings.theme.role.attn",
  "settings.theme.aa",
  "settings.theme.ratio",
  "settings.appearance.preset.night",
  "settings.appearance.mode.label",
  "settings.appearance.density.compact",
  "settings.appearance.toolDetail.compact",
  "settings.appearance.px",
  "settings.appearance.sample.agentLabel",
  "settings.appearance.sample.toolSummary",
  "settings.appearance.fontJetbrains",
  "shell.pane.terminal",
  "commands.palette.title",
  "commands.group.navigation",
  "commands.group.session",
  "commands.palette.group.actions",
  "commands.palette.group.sessions",
  "commands.group.agents",
  "commands.key.ctrl",
  "commands.key.alt",
  "commands.key.tab",
  "shell.age.min", // SI abbreviations
  "shell.age.hour",
  "search.detail", // placeholders only
]);

describe("i18n", () => {
  it("every error code has an en and fr message", () => {
    for (const code of [...ERROR_CODES, ...CLIENT_ERROR_CODES]) {
      const key = errorKey(code);
      expect(key, code).toBe(`error.${code}`);
      expect((en as Record<string, string>)[key]?.length).toBeGreaterThan(0);
      expect((fr as Record<string, string>)[key]?.length).toBeGreaterThan(0);
    }
    expect(errorKey("teapot")).toBe("error.internal");
  });

  it("translates every key into French", () => {
    const english: Record<string, string> = {
      ...en,
      ...sessionScreenEn,
      ...settingsScreenEn,
      ...settingsAccessEn,
      ...settingsAppearanceEn,
      ...settingsApprovalsEn,
      ...settingsShortcutsEn,
      ...sidebarEn,
      ...filesEn,
      ...changesEn,
      ...terminalEn,
    };
    const french: Record<string, string> = {
      ...fr,
      ...sessionScreenFr,
      ...settingsScreenFr,
      ...settingsAccessFr,
      ...settingsAppearanceFr,
      ...settingsApprovalsFr,
      ...settingsShortcutsFr,
      ...sidebarFr,
      ...filesFr,
      ...changesFr,
      ...terminalFr,
    };
    expect(Object.keys(french).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english)) {
      expect(french[key], key).toBeTruthy();
      if (!IDENTICAL_IN_FR.has(key)) expect(french[key], key).not.toBe(english[key]);
    }
  });

  it("picks French for French browsers, English otherwise, and a stored choice wins", () => {
    expect(pickLocale(["fr-FR", "en"], null)).toBe("fr");
    expect(pickLocale(["de-DE"], null)).toBe("en");
    expect(pickLocale(["fr-FR"], "en")).toBe("en");
  });

  it("interpolates variables", () => {
    expect(translate("en", "login.throttled", { seconds: 4 })).toBe("Too many attempts. Wait 4 s.");
    expect(translate("fr", "login.throttled", { seconds: 4 })).toBe("Trop de tentatives. Attendez 4 s.");
  });

  it("picks the plural form of the locale, with the count, and falls back to the other form", () => {
    // The session chunk registers these strings when it loads.
    registerCatalog({ en: sessionScreenEn, fr: sessionScreenFr });
    expect(plural("en", "sessions.queue.more", 1)).toBe("1 more");
    expect(plural("en", "sessions.queue.more", 7)).toBe("7 more");
    expect(plural("fr", "sessions.queue.more", 0)).toBe("0 de plus");
    expect(plural("fr", "sessions.queue.more", 1_000_000)).toBe("1000000 de plus");
  });

  it("picks the plural form of a lazy catalog once registered, with extra variables", () => {
    registerCatalog({ en: sidebarEn, fr: sidebarFr });
    expect(plural("en", "sidebar.older", 1, { chord: "⌘K" })).toBe("1 older session · search with ⌘K");
    expect(plural("en", "sidebar.older", 2, { chord: "⌘K" })).toBe("2 older sessions · search with ⌘K");
    expect(plural("fr", "sidebar.older", 0, { chord: "⌘K" })).toBe(
      "0 session plus ancienne · cherchez avec ⌘K",
    );
  });
});

describe("reactive locale (R128)", () => {
  afterEach(() => {
    setLocale("en");
    vi.restoreAllMocks();
  });

  it("re-renders a component that reads useT when the locale changes", async () => {
    setLocale("en");
    function Probe() {
      const t = useT();
      return <p>{t("gate.retry")}</p>;
    }
    const page = await mount(<Probe />);
    expect(text(page.container)).toBe("Retry");
    await act(async () => setLocale("fr"));
    expect(text(page.container)).toBe("Réessayer");
    await act(async () => setLocale("en"));
    await page.unmount();
  });

  it("tells listeners once per real change", () => {
    setLocale("en");
    let calls = 0;
    const stop = onLocaleChange(() => calls++);
    setLocale("en");
    setLocale("fr");
    stop();
    setLocale("en");
    expect(calls).toBe(1);
  });

  it("switchLocale stores the choice and sets the document language", () => {
    const stored: Record<string, string> = {};
    expect(
      switchLocale("fr", {
        storage: { setItem: (k, v) => void (stored[k] = v) },
        root: document.documentElement,
      }),
    ).toBe(true);
    expect([getLocale(), stored["pap.locale"], document.documentElement.lang]).toEqual(["fr", "fr", "fr"]);
    switchLocale("en", { storage: { setItem: () => {} }, root: document.documentElement });
  });

  it("switches for this page and says so when the browser refuses to store the choice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = {
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(switchLocale("fr", { storage: refused, root: document.documentElement })).toBe(false);
    expect(getLocale()).toBe("fr");
    expect(warn.mock.calls).toEqual([["pap: storage_refused"]]);
    switchLocale("en", { storage: { setItem: () => {} }, root: document.documentElement });
  });
});
