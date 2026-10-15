/** The quota limit chip in the session header (Task 17): registered by the session screen, with its chunk. */
export const usageEn = {
  "usage.limit.resets": "Resets {time}",
  "usage.limit.reached": "Limit reached",
  "usage.limit.menu": "Limit actions",
  "usage.limit.resumeNow": "Resume now",
  "usage.limit.cancelResume": "Cancel auto-resume",
} as const;

export const usageFr: { readonly [K in keyof typeof usageEn]: string } = {
  "usage.limit.resets": "Reprise à {time}",
  "usage.limit.reached": "Limite atteinte",
  "usage.limit.menu": "Actions de la limite",
  "usage.limit.resumeNow": "Reprendre maintenant",
  "usage.limit.cancelResume": "Annuler la reprise automatique",
};
