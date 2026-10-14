// First-run stepper: account, passkey, Pi (`firstRun.*`). Lazy: loaded with the stepper's own chunk
// (`features/auth/register-first-run.ts`), so the initial bundle does not carry it.
export const firstRunEn = {
  "firstRun.steps.label": "Setup steps",
  "firstRun.step.account": "Account",
  "firstRun.step.passkey": "Passkey",
  "firstRun.step.pi": "Pi",
  "firstRun.skip": "Skip",
  "firstRun.continue": "Continue",
  "firstRun.finish": "Finish",
  "firstRun.passkey.title": "Add a passkey",
  "firstRun.passkey.intro":
    "Sign in with this device instead of typing the password. You can also add one later in Settings.",
  "firstRun.passkey.unavailable":
    "Passkeys are not available in this browser or on this server. You can add one later in Settings.",
  "firstRun.passkey.added": "Passkey added.",
  "firstRun.pi.title": "Connect Pi",
  "firstRun.pi.intro":
    "Sign in to a model provider so the agent can answer. You can also do this later in Settings › Models.",
  "firstRun.pi.loading": "Reading the providers…",
  "firstRun.pi.retry": "Try again",
  "firstRun.pi.unreadable":
    "The providers could not be read. You can set them up later in Settings › Models.",
  "firstRun.pi.ready": "Ready",
  "firstRun.pi.readyModel": "{model} from {provider} is the default model.",
  "firstRun.pi.readyNoDefault": "A provider is signed in. No default model is set yet.",
  "firstRun.pi.change": "Change",
  "firstRun.pi.panelLoading": "Loading providers…",
  "firstRun.pi.panelRetry": "Try loading the providers again",
} as const;

export const firstRunFr: { readonly [K in keyof typeof firstRunEn]: string } = {
  "firstRun.steps.label": "Étapes de la configuration",
  "firstRun.step.account": "Compte",
  "firstRun.step.passkey": "Clé d'accès",
  "firstRun.step.pi": "Pi",
  "firstRun.skip": "Passer",
  "firstRun.continue": "Continuer",
  "firstRun.finish": "Terminer",
  "firstRun.passkey.title": "Ajouter une clé d'accès",
  "firstRun.passkey.intro":
    "Connectez-vous avec cet appareil au lieu de saisir le mot de passe. Vous pourrez aussi en ajouter une plus tard dans les réglages.",
  "firstRun.passkey.unavailable":
    "Les clés d'accès ne sont pas disponibles dans ce navigateur ou sur ce serveur. Vous pourrez en ajouter une plus tard dans les réglages.",
  "firstRun.passkey.added": "Clé d'accès ajoutée.",
  "firstRun.pi.title": "Connecter Pi",
  "firstRun.pi.intro":
    "Connectez un fournisseur de modèles pour que l'agent puisse répondre. Vous pourrez aussi le faire plus tard dans Réglages › Modèles.",
  "firstRun.pi.loading": "Lecture des fournisseurs…",
  "firstRun.pi.retry": "Réessayer",
  "firstRun.pi.unreadable":
    "Les fournisseurs n'ont pas pu être lus. Vous pourrez les configurer plus tard dans Réglages › Modèles.",
  "firstRun.pi.ready": "Prêt",
  "firstRun.pi.readyModel": "{model} de {provider} est le modèle par défaut.",
  "firstRun.pi.readyNoDefault": "Un fournisseur est connecté. Aucun modèle par défaut n'est encore choisi.",
  "firstRun.pi.change": "Modifier",
  "firstRun.pi.panelLoading": "Chargement des fournisseurs…",
  "firstRun.pi.panelRetry": "Réessayer de charger les fournisseurs",
};
