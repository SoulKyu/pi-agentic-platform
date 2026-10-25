import { Button, TextField, usePendingAction, Heading } from "@pap/ui";
import { FONT_FAMILY_PATTERN } from "@pap/contracts";
import { useEffect, useState } from "react";
import { useT, type MessageKey } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { loadFonts, useFontsStore } from "./fonts-store.ts";

const ERRORS: Readonly<Record<string, MessageKey>> = {
  bad_request: "settings.appearance.fonts.error.bad_request",
  not_found: "settings.appearance.fonts.error.not_found",
  network: "settings.appearance.fonts.error.network",
  limit_reached: "settings.appearance.fonts.error.limit_reached",
  payload_too_large: "settings.appearance.fonts.error.payload_too_large",
};

/**
 * Settings › Appearance › Details › Google Fonts: the owner types a family name, pap downloads it once and serves it
 * from its own origin. Nothing here loads from Google: the link text is plain text.
 */
export function FontsBlock() {
  const t = useT();
  const families = useFontsStore((state) => state.families);
  const working = usePendingAction();
  const [name, setName] = useState("");
  const [error, setError] = useState<MessageKey | null>(null);

  useEffect(() => {
    void loadFonts(getRuntime().rpc);
  }, []);

  const refresh = async () => {
    await loadFonts(getRuntime().rpc);
  };
  const add = () =>
    void working.run(async () => {
      const family = name.trim().replace(/ +/g, " ");
      if (!FONT_FAMILY_PATTERN.test(family)) return setError(ERRORS.bad_request ?? null);
      setError(null);
      try {
        await getRuntime().rpc.call("fonts.add", { family });
        setName("");
      } catch (failure) {
        setError(
          (failure instanceof RpcError ? ERRORS[failure.code] : undefined) ??
            "settings.appearance.fonts.error.other",
        );
      }
      await refresh();
    });
  const remove = (slug: string) =>
    void working.run(async () => {
      setError(null);
      try {
        await getRuntime().rpc.call("fonts.remove", { slug });
      } catch {
        setError("settings.appearance.fonts.removeFailed");
      }
      await refresh();
    });

  return (
    <div className="flex flex-col gap-s2" data-slot="fonts-block">
      <Heading level={3} variant="group">
        {t("settings.appearance.fonts.title")}
      </Heading>
      <p className="text-ui text-muted">{t("settings.appearance.fonts.note")}</p>
      <div className="flex items-end gap-s2">
        <div className="min-w-0 flex-1">
          <TextField
            label={t("settings.appearance.fonts.family")}
            name="font-family"
            value={name}
            placeholder={t("settings.appearance.fonts.placeholder")}
            hint={t("settings.appearance.fonts.browseHint", { site: t("settings.appearance.fonts.browse") })}
            error={error === null ? null : t(error)}
            onChange={setName}
            autoComplete="off"
          />
        </div>
        <Button variant="secondary" pendingSince={working.since} onClick={add} disabled={name.trim() === ""}>
          {t("settings.appearance.fonts.add")}
        </Button>
      </div>
      <Heading level={3} variant="group">
        {t("settings.appearance.fonts.installed")}
      </Heading>
      {families === null || families.length === 0 ? (
        <p className="text-ui text-muted">{t("settings.appearance.fonts.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-s1">
          {families.map((entry) => (
            <li
              key={entry.slug}
              className="flex items-center justify-between gap-s2 border border-border p-s2"
            >
              <span className="min-w-0 break-words text-ui text-fg">
                {entry.family}
                <span className="text-muted">
                  {" · "}
                  {t("settings.appearance.fonts.meta", {
                    files: entry.files,
                    kb: Math.max(1, Math.round(entry.bytes / 1024)),
                  })}
                </span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                aria-label={t("settings.appearance.fonts.removeAlt", { family: entry.family })}
                onClick={() => remove(entry.slug)}
              >
                {t("settings.appearance.fonts.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
