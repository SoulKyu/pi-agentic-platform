import { settingsMcpEn, settingsMcpFr } from "../../i18n/catalog/settings-mcp.ts";
import { settingsMcpAddEn, settingsMcpAddFr } from "../../i18n/catalog/settings-mcp-add.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Evaluated with the section's own chunk, before any of its components renders.
registerCatalog({
  en: { ...settingsMcpEn, ...settingsMcpAddEn },
  fr: { ...settingsMcpFr, ...settingsMcpAddFr },
});
