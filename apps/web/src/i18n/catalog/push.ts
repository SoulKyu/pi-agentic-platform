// Lazy: the push client's copy (`features/notifications/`, the re-enable banner), registered by `register-push.ts`.
export const pushEn = {
  "push.support.insecure": "Notifications and installation need HTTPS.",
  "push.support.needs_install_ios":
    "Add pap to the home screen (Share, then Add to Home Screen), then enable notifications here.",
  "push.support.no_service_worker": "This browser has no service worker, so it cannot receive notifications.",
  "push.support.no_push_api": "This browser does not support push notifications.",
  "push.support.denied": "Notifications are blocked for pap. Allow them in the browser's site settings.",
  "push.support.unsupported": "This browser cannot receive notifications.",
  "push.enable.refused": "The server cannot send notifications right now.",
  "push.enable.capacity": "This account already has the most devices it can hold. Remove one first.",
  "push.enable.failed": "Notifications could not be enabled. Try again.",
  "push.reenable.title": "Re-enable notifications",
  "push.reenable.body":
    "This device stopped receiving notifications: the notification key changed, or this device was removed from the list. One tap turns them back on.",
  "push.reenable.action": "Re-enable",
  "push.reenable.later": "Later",
};

export const pushFr: Record<keyof typeof pushEn, string> = {
  "push.support.insecure": "Les notifications et l'installation demandent HTTPS.",
  "push.support.needs_install_ios":
    "Ajoutez pap à l'écran d'accueil (Partager, puis Sur l'écran d'accueil), puis activez les notifications ici.",
  "push.support.no_service_worker":
    "Ce navigateur n'a pas de service worker : il ne peut pas recevoir de notifications.",
  "push.support.no_push_api": "Ce navigateur ne prend pas en charge les notifications push.",
  "push.support.denied":
    "Les notifications sont bloquées pour pap. Autorisez-les dans les réglages du site du navigateur.",
  "push.support.unsupported": "Ce navigateur ne peut pas recevoir de notifications.",
  "push.enable.refused": "Le serveur ne peut pas envoyer de notifications pour le moment.",
  "push.enable.capacity": "Ce compte a déjà le nombre maximal d'appareils. Retirez-en un d'abord.",
  "push.enable.failed": "Les notifications n'ont pas pu être activées. Réessayez.",
  "push.reenable.title": "Réactiver les notifications",
  "push.reenable.body":
    "Cet appareil ne reçoit plus les notifications : la clé de notification a changé, ou cet appareil a été retiré de la liste. Un appui suffit pour les réactiver.",
  "push.reenable.action": "Réactiver",
  "push.reenable.later": "Plus tard",
};
