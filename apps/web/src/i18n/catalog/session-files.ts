// Lazy: the composer's mention menu and attachment tray (`features/sessions/composer/register-files-catalog.ts`).
export const sessionFilesEn = {
  "sessions.files.mentions": "Files in this project",
  "sessions.files.attach": "Attach files",
  "sessions.files.tray": "Attached files",
  "sessions.files.uploading": "Uploading…",
  "sessions.files.remove": "Remove {name}",
  "sessions.files.removeLabel": "Remove",
  "sessions.files.retry": "Retry {name}",
  "sessions.files.retryLabel": "Retry",
  "sessions.files.tooMany": "At most {count} files per message",
  "sessions.files.folders": "Folders are not uploaded",
  "sessions.files.interrupted":
    "The upload stopped before the end: a slow or dropped connection. Try again on a faster link.",
  "sessions.files.sentAsFile": "Sent as a file",
  "sessions.files.expired": "The attached files expired. Attach them again.",
  "sessions.files.imageRejected":
    "The message was not sent: an image could not be read, or this model cannot take images. Remove it and try again.",
  "sessions.files.drop": "Drop files to attach them",
  "sessions.files.tooLarge": "This file is larger than 25 MB.",
  "sessions.files.notReady": "Wait for the files to upload, and retry or remove the ones that failed.",
  "sessions.files.limitReached": "Too many files are waiting. Send the message, or remove some.",
} as const;

export const sessionFilesFr: Record<keyof typeof sessionFilesEn, string> = {
  "sessions.files.mentions": "Fichiers de ce projet",
  "sessions.files.attach": "Joindre des fichiers",
  "sessions.files.tray": "Fichiers joints",
  "sessions.files.uploading": "Envoi en cours…",
  "sessions.files.remove": "Retirer {name}",
  "sessions.files.removeLabel": "Retirer",
  "sessions.files.retry": "Réessayer {name}",
  "sessions.files.retryLabel": "Réessayer",
  "sessions.files.tooMany": "{count} fichiers au plus par message",
  "sessions.files.folders": "Les dossiers ne sont pas envoyés",
  "sessions.files.interrupted":
    "L'envoi s'est arrêté avant la fin : connexion lente ou coupée. Réessayez sur une liaison plus rapide.",
  "sessions.files.sentAsFile": "Envoyé comme fichier",
  "sessions.files.expired": "Les fichiers joints ont expiré. Joignez-les à nouveau.",
  "sessions.files.imageRejected":
    "Le message n'a pas été envoyé : une image est illisible, ou ce modèle n'accepte pas les images. Retirez-la et réessayez.",
  "sessions.files.drop": "Déposez les fichiers pour les joindre",
  "sessions.files.tooLarge": "Ce fichier dépasse 25 Mo.",
  "sessions.files.notReady":
    "Attendez la fin de l'envoi des fichiers, puis réessayez ou retirez ceux qui ont échoué.",
  "sessions.files.limitReached": "Trop de fichiers en attente. Envoyez le message, ou retirez-en.",
};
