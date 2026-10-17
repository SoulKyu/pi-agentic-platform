// Lazy: the update banner (`routes/shell/UpdateBanner.tsx`), registered by `register-pwa.ts`.
export const pwaEn = {
  "pwa.update.title": "The page has an update",
  "pwa.update.body": "Reload to use the up-to-date page.",
  "pwa.update.reload": "Reload",
  "pwa.update.later": "Later",
  "pwa.hide": "Hide",
  "pwa.failed.title": "Installed mode could not start",
  "pwa.failed.body":
    "The service worker did not install, so notifications and offline start are unavailable. The page itself works. If pap sits behind a proxy, check that it does not redirect /sw.js.",
};

export const pwaFr: Record<keyof typeof pwaEn, string> = {
  "pwa.update.title": "La page a une mise à jour",
  "pwa.update.body": "Rechargez pour utiliser la page à jour.",
  "pwa.update.reload": "Recharger",
  "pwa.update.later": "Plus tard",
  "pwa.hide": "Masquer",
  "pwa.failed.title": "Le mode installé n'a pas pu démarrer",
  "pwa.failed.body":
    "Le service worker ne s'est pas installé : les notifications et le démarrage hors ligne ne sont pas disponibles. La page, elle, fonctionne. Si pap est derrière un proxy, vérifiez qu'il ne redirige pas /sw.js.",
};
