export const settingsEn = {
  "settings.language.en": "English",
  "settings.language.fr": "Français",
} as const;

export const settingsFr: { readonly [K in keyof typeof settingsEn]: string } = {
  "settings.language.en": "English",
  "settings.language.fr": "Français",
};
