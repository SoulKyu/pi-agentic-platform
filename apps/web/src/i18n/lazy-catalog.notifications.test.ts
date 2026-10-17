import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import { notificationsEn, notificationsFr } from "./catalog/notifications.ts";

const src = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

describe("lazy catalog (notifications)", () => {
  it("has the same keys in English and French, none empty", () => {
    expect(Object.keys(notificationsFr)).toEqual(Object.keys(notificationsEn));
    for (const key of Object.keys(notificationsFr) as Array<keyof typeof notificationsFr>)
      expect(notificationsFr[key], key).not.toBe("");
  });

  it("the French copy uses vous: no tu, ton, ta", () => {
    const source = readFileSync(join(import.meta.dirname, "catalog", "notifications.ts"), "utf8");
    const frenchPart = source.slice(source.indexOf("notificationsFr"));
    expect(frenchPart).not.toMatch(/ tu | ton | ta /i);
    for (const text of Object.values(notificationsFr))
      expect(text).not.toMatch(/(^| )(tu|ton|ta|tes|toi)( |$)/i);
  });

  it("carries the owner's exact sentences", () => {
    expect(notificationsFr["notifications.status.on"]).toBe("Notifications actives");
    expect(notificationsFr["notifications.names.hint"]).toBe(
      "Seul le nom que vous avez donné au déclencheur ou à l'agent s'affiche. Jamais le contenu : ni commande, ni chemin, ni message, ni titre de tâche.",
    );
    expect(notificationsFr["notifications.cap"].replace("{max}", "10")).toBe("10 appareils au maximum");
    expect(notificationsFr["notifications.reenable"]).toBe("Réactiver les notifications");
    expect(notificationsFr["notifications.enable"]).toBe("Activer sur cet appareil");
    expect(notificationsFr["notifications.test"]).toBe("Envoyer une notification de test");
  });

  it("the French copy puts a space before every colon (W6-R9)", () => {
    const tight = Object.entries(notificationsFr)
      .filter(([, text]) => /[\p{L}\d)]:(?!\/\/)/u.test(text.replaceAll("{", " ")))
      .map(([key]) => key);
    expect(tight).toEqual([]);
  });

  it("the French test result and mute label do not agree with a count", () => {
    expect(notificationsFr["notifications.mute.off"]).toBe("Désactivée");
    expect(notificationsFr["notifications.test.result"]).toContain("notification : {delivered}");
    expect(notificationsFr["notifications.test.result"]).toContain("abandonnées : {dropped}");
  });

  it("every approval hint says that approvals wait 60 seconds", () => {
    expect(notificationsEn["notifications.class.approval.hint"]).toContain("60 seconds");
    expect(notificationsFr["notifications.class.approval.hint"]).toContain("60 secondes");
  });

  it("stays out of the eager catalogs and is named only by lazy code", () => {
    expect(Object.keys(en).filter((key) => key.startsWith("notifications."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("notifications."))).toEqual([]);
    const offenders = files(src)
      .map((file) => relative(src, file).split("\\").join("/"))
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.|^i18n\/|^testing\//.test(name))
      .filter((name) => !/^features\/notifications\//.test(name))
      .filter((name) => /["'`]notifications\.[a-z]/.test(readFileSync(join(src, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});
