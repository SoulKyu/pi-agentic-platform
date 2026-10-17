// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, text } from "../testing/dom.ts";
import { galleryEn, galleryFr } from "./catalog/gallery.ts";
import { serverEn, serverFr } from "./catalog/server.ts";
import { sessionPolicyEn, sessionPolicyFr } from "./catalog/session-policy.ts";
import { sessionScreenEn, sessionScreenFr } from "./catalog/session-screen.ts";
import { settingsScreenEn, settingsScreenFr } from "./catalog/settings-screen.ts";
import { settingsAccessEn, settingsAccessFr } from "./catalog/settings-access.ts";
import { settingsAppearanceEn, settingsAppearanceFr } from "./catalog/settings-appearance.ts";
import { settingsApprovalsEn, settingsApprovalsFr } from "./catalog/settings-approvals.ts";
import { settingsShortcutsEn, settingsShortcutsFr } from "./catalog/settings-shortcuts.ts";
import { sidebarEn, sidebarFr } from "./catalog/sidebar.ts";
import { registerCatalog, setLocale, translate, useT } from "./index.ts";

const src = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

afterEach(() => setLocale("en"));

function registerSettingsCatalogs() {
  for (const entries of [
    { en: settingsScreenEn, fr: settingsScreenFr },
    { en: settingsAccessEn, fr: settingsAccessFr },
    { en: settingsAppearanceEn, fr: settingsAppearanceFr },
    { en: settingsApprovalsEn, fr: settingsApprovalsFr },
    { en: settingsShortcutsEn, fr: settingsShortcutsFr },
  ])
    registerCatalog(entries);
}

describe("lazy catalog (Settings)", () => {
  it("shows the key and reports it until the chunk registers its strings, then resolves and re-renders mounted consumers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    function Probe() {
      const t = useT();
      return <p>{t("settings.appearance.status.saved")}</p>;
    }
    const page = await mount(<Probe />);
    expect(text(page.container)).toBe("settings.appearance.status.saved");
    expect(warn).toHaveBeenCalledWith("pap: message_missing");
    await act(async () => registerSettingsCatalogs());
    expect(text(page.container)).toBe("Saved to your account");
    await act(async () => setLocale("fr"));
    expect(text(page.container)).toBe("Enregistré dans votre compte");
    expect(translate("en", "settings.appearance.px", { value: 13 })).toBe("13 px");
    expect(translate("en", "approvals.intro")).toBe(
      "What the agent may do without asking you, and what it may never do.",
    );
    expect(translate("fr", "approvals.intro")).toBe(
      "Ce que l'agent peut faire sans vous demander, et ce qu'il ne peut jamais faire.",
    );
    await page.unmount();
    warn.mockRestore();
  });

  it("is referenced only from the Settings chunk: eager code can never render a raw key", () => {
    const lazy = [
      ...Object.keys(settingsScreenEn),
      ...Object.keys(settingsAccessEn),
      ...Object.keys(settingsAppearanceEn),
      ...Object.keys(settingsApprovalsEn),
      ...Object.keys(settingsShortcutsEn),
    ];
    // Explicit: features/appearance also holds the eager boot files (index, controller, store, model).
    const chunk = new Set([
      "routes/settings/AccountSection.tsx",
      "routes/settings/ApprovalsSection.tsx",
      "routes/settings/LanguageSection.tsx",
      "routes/settings/McpSettings.tsx",
      "routes/settings/SkillsSettings.tsx",
      "routes/settings/ModelsSettings.tsx",
      "routes/settings/MemorySettings.tsx",
      "routes/settings/AutomationSettings.tsx",
      "routes/settings/NotificationsSettings.tsx",
      "routes/settings/register-settings-catalog.ts",
      "routes/settings/SettingsScreen.tsx",
      "routes/settings/sections.tsx",
      "features/auth/DevicesList.tsx",
      "features/auth/InlineAsk.tsx",
      "features/auth/PasskeysList.tsx",
      "features/auth/StepUp.tsx",
      "features/auth/TokenCreate.tsx",
      "features/auth/TokensPanel.tsx",
      "features/auth/use-listing.ts",
      "features/auth/use-mutation.ts",
      "features/commands/editor/KeybindingsJson.tsx",
      "features/commands/editor/ShortcutRecorder.tsx",
      "features/commands/editor/ShortcutRow.tsx",
      "features/commands/editor/ShortcutsEditor.tsx",
      "features/policy/ApprovalsPanel.tsx",
      "features/policy/AuditLog.tsx",
      "features/policy/AuditRow.tsx",
      "features/policy/use-audit-log.ts",
      "features/policy/BuiltinPreset.tsx",
      "features/policy/ModeField.tsx",
      "features/policy/ReadOnlyCommands.tsx",
      "features/policy/PatternField.tsx",
      "features/policy/RulesByProject.tsx",
      "features/appearance/AgentsSection.tsx",
      "features/appearance/AppearancePanel.tsx",
      "features/appearance/AppearancePreview.tsx",
      "features/appearance/AppearanceSection.tsx",
      "features/appearance/CustomThemes.tsx",
      "features/appearance/DetailsSection.tsx",
      "features/appearance/HomeSection.tsx",
      "features/appearance/ReadingSection.tsx",
      "features/appearance/ThemeEditor.tsx",
      "features/appearance/ThemeImport.tsx",
      "features/appearance/ThemeSection.tsx",
    ]);
    // A stale entry would silently exempt nothing: every listed file must exist.
    expect([...chunk].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const inChunk = (file: string) => chunk.has(file);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || inChunk(name)) continue;
      const code = readFileSync(file, "utf8");
      for (const key of lazy)
        if (code.includes(`"${key}"`) || code.includes(`\`${key}`)) offenders.push(`${name}: ${key}`);
      if (
        /settings\.(?:appearance|theme|language|account|nav|section|shortcuts)|["'`](?:approvals|audit|access)\./.test(
          code,
        )
      )
        offenders.push(`${name}: settings prefix`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("lazy catalog (audit log)", () => {
  it("has English and French strings with the same slots", async () => {
    await act(async () => registerSettingsCatalogs());
    expect(translate("en", "audit.title")).toBe("Audit log");
    expect(translate("fr", "audit.title")).toBe("Journal d'audit");
    expect(translate("fr", "audit.session.tools", { count: 2, names: "a, b" })).toBe("Outils (2) : a, b");
    const slots = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(settingsApprovalsEn) as Array<keyof typeof settingsApprovalsEn>)
      expect(slots(settingsApprovalsFr[key]), key).toEqual(slots(settingsApprovalsEn[key]));
  });
});

describe("lazy catalog (gallery)", () => {
  it("registers its strings with the gallery chunk, English and French", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(translate("en", "gallery.heading")).toBe("gallery.heading");
    await act(async () => registerCatalog({ en: galleryEn, fr: galleryFr }));
    expect(translate("en", "gallery.heading")).toBe("UI gallery");
    expect(translate("fr", "gallery.heading")).toBe("Galerie de l'interface");
    expect(translate("fr", "gallery.frame", { theme: "Nuit", density: "Mixte" })).toBe("Nuit · Mixte");
  });

  it("is referenced only from the gallery directory: shipped code can never render a raw gallery key", () => {
    // The whole directory is the lazy chunk; every other file is held to the strict rule.
    const inGallery = (file: string) => file.startsWith("gallery/");
    expect(readdirSync(join(src, "gallery")).length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || inGallery(name)) continue;
      const code = readFileSync(file, "utf8");
      for (const key of Object.keys(galleryEn))
        if (code.includes(`"${key}"`) || code.includes(`\`${key}`)) offenders.push(`${name}: ${key}`);
      if (/["'`]gallery\./.test(code)) offenders.push(`${name}: gallery prefix`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the gallery strings out of the eager catalogs", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("gallery."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("gallery."))).toEqual([]);
  });
});

describe("lazy catalog (server texts)", () => {
  it("registers its strings with the session screen, English and French, the same slots in both", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => registerCatalog({ en: serverEn, fr: serverFr }));
    expect(translate("en", "server.cause.exitCode", { code: "70" })).toBe(
      "Agent process exited with code 70.",
    );
    expect(translate("fr", "server.cause.exitCode", { code: "70" })).toBe(
      "Le processus de l'agent s'est arrêté avec le code 70.",
    );
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(serverEn) as Array<keyof typeof serverEn>)
      expect(slots(serverFr[key]), key).toEqual(slots(serverEn[key]));
  });

  it("is loaded only by the session screen: nothing eager imports the texts or the catalog", () => {
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name)) continue;
      const code = readFileSync(file, "utf8");
      if (
        /server-text\.ts"|catalog\/server\.ts"|register-server-catalog\.ts"/.test(code) &&
        !name.startsWith("features/sessions/")
      )
        offenders.push(name);
      if (/["'`]server\.(?:notice|cause)\./.test(code)) offenders.push(`${name}: server key`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the server strings out of the eager catalogs", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("server."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("server."))).toEqual([]);
  });
});

describe("lazy catalog (sidebar)", () => {
  it("registers its strings with the tree chunk, English and French, the same slots in both", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => registerCatalog({ en: sidebarEn, fr: sidebarFr }));
    expect(translate("en", "sidebar.showMore")).toBe("Show 20 more");
    expect(translate("fr", "sidebar.showMore")).toBe("En afficher 20 de plus");
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(sidebarEn) as Array<keyof typeof sidebarEn>)
      expect(slots(sidebarFr[key]), key).toEqual(slots(sidebarEn[key]));
  });

  it("is referenced only from the projects .tsx files, the palette's search files and Transcript.tsx", () => {
    // Later tasks add their lazy files here; the register file is the only other importer.
    const inChunk = (file: string) =>
      (file.startsWith("features/projects/") && file.endsWith(".tsx")) ||
      file === "features/commands/palette/CommandPalette.tsx" ||
      file === "features/commands/palette/TranscriptHits.tsx" ||
      file === "features/sessions/Transcript.tsx";
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || inChunk(name)) continue;
      const code = readFileSync(file, "utf8");
      for (const key of Object.keys(sidebarEn))
        if (code.includes(`"${key}"`) || code.includes(`\`${key}`)) offenders.push(`${name}: ${key}`);
      if (/["'`]sidebar\./.test(code)) offenders.push(`${name}: sidebar prefix`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the sidebar strings out of the eager catalogs", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    const sidebarKey = (key: string) => key.startsWith("sidebar.") || key.startsWith("search.");
    expect(Object.keys(en).filter(sidebarKey)).toEqual([]);
    expect(Object.keys(fr).filter(sidebarKey)).toEqual([]);
  });
});

describe("lazy catalog (session screen)", () => {
  it("registers M2's session strings with the session chunk, English and French, the same slots in both", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => registerCatalog({ en: sessionScreenEn, fr: sessionScreenFr }));
    expect(translate("en", "sessions.composer.send")).toBe("Send");
    expect(translate("fr", "sessions.composer.send")).toBe("Envoyer");
    expect(Object.keys(sessionScreenEn)).toHaveLength(109);
    expect(Object.keys(sessionScreenFr)).toEqual(Object.keys(sessionScreenEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(sessionScreenEn) as Array<keyof typeof sessionScreenEn>)
      expect(slots(sessionScreenFr[key]), key).toEqual(slots(sessionScreenEn[key]));
  });

  it("is referenced only from the session chunk's files: eager code can never render a raw key", () => {
    const chunk = new Set([
      ...[
        "AlwaysRules",
        "BranchSwitcher",
        "Composer",
        "CrashBanner",
        "CustomPanel",
        "MessageRow",
        "Minimap",
        "QueueStrip",
        "RowActions",
        "SessionActions",
        "SessionPolicy",
        "SessionScreen",
        "ToolItemCard",
        "Transcript",
      ].map((name) => `features/sessions/${name}.tsx`),
      "features/sessions/use-composer.ts",
      "features/sessions/notice-toast.ts",
      ...[
        "ApprovalCardFor",
        "ConfirmDialog",
        "DialogList",
        "SelectDialog",
        "TextDialog",
        "request-frame",
        "use-clipped",
      ].map((name) => `features/sessions/dialogs/${name}.tsx`),
    ]);
    expect(chunk.size).toBe(23);
    // A stale entry would silently exempt nothing: every listed file must exist.
    expect([...chunk].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || chunk.has(name)) continue;
      const code = readFileSync(file, "utf8");
      for (const key of Object.keys(sessionScreenEn))
        if (code.includes(`"${key}"`) || code.includes(`\`${key}`)) offenders.push(`${name}: ${key}`);
      if (
        /["'\x60](?:sessions\.(?:queue|composer|tool|minimap)|session\.(?:outsideWrite|crash)|dialog|panel|actions|rules)\./.test(
          code,
        )
      )
        offenders.push(`${name}: session prefix`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps M2's session strings out of the eager catalogs", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    const moved = Object.keys(sessionScreenEn);
    expect(Object.keys(en).filter((key) => moved.includes(key))).toEqual([]);
    expect(Object.keys(fr).filter((key) => moved.includes(key))).toEqual([]);
  });
});

describe("lazy catalog (session policy)", () => {
  it("registers its strings with the session screen, English and French, the same slots in both", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(translate("en", "sessionPolicy.external")).toBe("sessionPolicy.external");
    await act(async () => registerCatalog({ en: sessionPolicyEn, fr: sessionPolicyFr }));
    expect(translate("en", "sessionPolicy.external")).toBe("External content");
    expect(translate("fr", "sessionPolicy.taintedCategory", { category: "exec" })).toBe(
      "exec · contenu externe",
    );
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(sessionPolicyEn) as Array<keyof typeof sessionPolicyEn>)
      expect(slots(sessionPolicyFr[key]), key).toEqual(slots(sessionPolicyEn[key]));
  });

  it("is loaded only by the session screen: nothing eager imports the catalog or uses its keys", () => {
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name)) continue;
      const code = readFileSync(file, "utf8");
      if (
        /catalog\/session-policy\.ts"|register-policy-catalog\.ts"/.test(code) &&
        !name.startsWith("features/sessions/")
      )
        offenders.push(name);
      if (/["'`]sessionPolicy\./.test(code) && !name.startsWith("features/sessions/"))
        offenders.push(`${name}: sessionPolicy key`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the session policy strings out of the eager catalogs", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("sessionPolicy."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("sessionPolicy."))).toEqual([]);
  });
});
