/** Settings › Models › Usage (Task 18): registered with the component's chunk, never eagerly. */
export const modelsUsageEn = {
  "modelsUsage.title": "Usage",
  "modelsUsage.note":
    "pap asks the provider's official usage address with the key Pi stores, only when you click.",
  "modelsUsage.check": "Check usage",
  "modelsUsage.checkedAt": "Checked at {time}",
  "modelsUsage.resets": "Resets {time}",
  "modelsUsage.percentUsed": "{used}% used",
  "modelsUsage.of": "{used} / {limit}",
  "modelsUsage.left": "{amount} left",
  "modelsUsage.used": "{amount} used",
  "modelsUsage.auth": "pap could not read a sign-in for this provider. Sign in, then try again.",
  "modelsUsage.failed": "The usage query failed. Try again in a minute.",
  "modelsUsage.unsupported": "pap cannot show usage for this provider.",
  "modelsUsage.overridden":
    "An extension points this provider to another address, so pap did not send the key. Usage is not checked.",
  "modelsUsage.extensionsFailed":
    "An extension failed to load, so pap did not send the key. Fix or disable it, then try again.",
} as const;

export const modelsUsageFr: { readonly [K in keyof typeof modelsUsageEn]: string } = {
  "modelsUsage.title": "Consommation",
  "modelsUsage.note":
    "pap interroge l'adresse officielle du fournisseur avec la clé que Pi garde, seulement quand vous cliquez.",
  "modelsUsage.check": "Voir la consommation",
  "modelsUsage.checkedAt": "Vérifié à {time}",
  "modelsUsage.resets": "Réinitialisation {time}",
  "modelsUsage.percentUsed": "{used} % utilisé",
  "modelsUsage.of": "{used} / {limit}",
  "modelsUsage.left": "{amount} restant",
  "modelsUsage.used": "{amount} utilisé",
  "modelsUsage.auth": "pap n'a pas pu lire de connexion pour ce fournisseur. Connectez-vous, puis réessayez.",
  "modelsUsage.failed": "La requête de consommation a échoué. Réessayez dans une minute.",
  "modelsUsage.unsupported": "pap ne peut pas afficher la consommation de ce fournisseur.",
  "modelsUsage.overridden":
    "Une extension redirige ce fournisseur vers une autre adresse : pap n'a pas envoyé la clé. La consommation n'est pas vérifiée.",
  "modelsUsage.extensionsFailed":
    "Une extension n'a pas pu se charger : pap n'a pas envoyé la clé. Corrigez-la ou désactivez-la, puis réessayez.",
};
