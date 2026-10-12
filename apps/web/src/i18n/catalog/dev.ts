// The pane title of the dev-only /dev/ui item. en.ts and fr.ts include it only when `import.meta.env.DEV` is true,
// so a production bundle carries no trace of the gallery's name (ADR 0011).
export const devEn = { "shell.tab.devUi": "UI gallery" } as const;
export const devFr: { readonly [K in keyof typeof devEn]: string } = {
  "shell.tab.devUi": "Galerie de l'interface",
};
