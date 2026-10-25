// The invitation page (`invite.*`). Lazy: loaded with the page's own chunk (`features/auth/register-invite.ts`).
export const inviteEn = {
  "invite.title": "Join pap",
  "invite.inviter": "{inviter} invites you.",
  "invite.loading": "Checking the invitation…",
  "invite.submit": "Create my account",
  "invite.signedIn": "Signed in as {name}. Accepting signs {name} out.",
  "invite.continue": "Continue",
  "invite.back": "Go back",
  "invite.retry": "Retry",
  "invite.retryHint": "Your invitation may still be valid. Try again in a moment.",
} as const;

export const inviteFr: { readonly [K in keyof typeof inviteEn]: string } = {
  "invite.title": "Rejoindre pap",
  "invite.inviter": "{inviter} vous invite.",
  "invite.loading": "Vérification de l'invitation…",
  "invite.submit": "Créer mon compte",
  "invite.signedIn": "Connecté en tant que {name}. Accepter vous déconnecte de {name}.",
  "invite.continue": "Continuer",
  "invite.back": "Retour",
  "invite.retry": "Réessayer",
  "invite.retryHint": "Votre invitation est peut-être encore valable. Réessayez dans un instant.",
};
