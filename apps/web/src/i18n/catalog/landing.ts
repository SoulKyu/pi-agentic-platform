// Lazy: the `/n/<id>` landing (`features/notifications/Landing.tsx`), registered by `register-landing.ts`.
export const landingEn = {
  "landing.loading": "Opening the notification…",
  "landing.notFound.title": "This notification no longer exists",
  "landing.notFound.purpose": "It is no longer available.",
  "landing.notFound.home": "Go home",
  "landing.handled.title": "Already handled",
  "landing.handled.purpose": "Nothing waits for an answer here anymore.",
  "landing.handled.inbox": "Open the Inbox",
  "landing.failed.title": "The notification could not be opened",
  "landing.failed.retry": "Try again",
} as const;

export const landingFr: Record<keyof typeof landingEn, string> = {
  "landing.loading": "Ouverture de la notification…",
  "landing.notFound.title": "Cette notification n'existe plus",
  "landing.notFound.purpose": "Elle n'est plus disponible.",
  "landing.notFound.home": "Retour à l'accueil",
  "landing.handled.title": "Déjà traité",
  "landing.handled.purpose": "Plus rien n'attend de réponse ici.",
  "landing.handled.inbox": "Ouvrir la boîte de réception",
  "landing.failed.title": "La notification n'a pas pu être ouverte",
  "landing.failed.retry": "Réessayer",
};
