export const shellEn = {
  "ui.dismiss": "Dismiss",
  "ui.close": "Close",
  "server.notice.messageTooLarge": "A message was too large to stream.",
  "server.notice.dialogTooLarge":
    "An extension asked a question that was too large to show. It was cancelled.",
  "server.notice.dialogLimit": "An extension asked a question while too many were waiting. It was cancelled.",
  "server.notice.extensionFailed": "An extension failed.",
  "server.notice.extensionFailedDuring": "An extension failed during {event}.",
  "server.cause.stopped": "Agent process stopped.",
  "server.cause.exitCode": "Agent process exited with code {code}.",
  "server.cause.signal": "Agent process stopped by {signal}.",
  "server.cause.signalUnknown": "Agent process stopped by a signal.",
  "server.cause.killed": "Agent process killed (SIGKILL), possibly out of memory.",
  "server.cause.spawnFailure": "Agent process could not start.",
} as const;

export const shellFr: { readonly [K in keyof typeof shellEn]: string } = {
  "ui.dismiss": "Fermer",
  "ui.close": "Fermer",
  "server.notice.messageTooLarge": "Un message était trop volumineux pour être diffusé.",
  "server.notice.dialogTooLarge":
    "Une extension a posé une question trop volumineuse pour être affichée. Elle a été annulée.",
  "server.notice.dialogLimit":
    "Une extension a posé une question alors que trop d'autres attendaient. Elle a été annulée.",
  "server.notice.extensionFailed": "Une extension a échoué.",
  "server.notice.extensionFailedDuring": "Une extension a échoué pendant {event}.",
  "server.cause.stopped": "Le processus de l'agent s'est arrêté.",
  "server.cause.exitCode": "Le processus de l'agent s'est arrêté avec le code {code}.",
  "server.cause.signal": "Le processus de l'agent a été arrêté par {signal}.",
  "server.cause.signalUnknown": "Le processus de l'agent a été arrêté par un signal.",
  "server.cause.killed": "Le processus de l'agent a été tué (SIGKILL), peut-être faute de mémoire.",
  "server.cause.spawnFailure": "Le processus de l'agent n'a pas pu démarrer.",
};
