// The daemon's own fixed sentences, by code (R128). Lazy: only the session screen shows them (`server-text.ts`).
export const serverEn = {
  "server.notice.messageTooLarge": "A message was too large to stream.",
  "server.notice.dialogTooLarge":
    "An extension asked a question that was too large to show. It was cancelled.",
  "server.notice.dialogLimit": "An extension asked a question while too many were waiting. It was cancelled.",
  "server.notice.approvalUnshown": "A question about a tool call could not be shown. The call was blocked.",
  "server.notice.extensionFailed": "An extension failed.",
  "server.notice.extensionFailedDuring": "An extension failed during {event}.",
  "server.notice.panelsLimit": "An extension opened too many panels. The extra one was cancelled.",
  "server.notice.heldOne": "1 more notice from extensions was not shown.",
  "server.notice.heldMany": "{count} more notices from extensions were not shown.",
  "server.notice.rulesFull":
    "This project already has {max} always-allowed calls: this one is allowed until this project's rules change.",
  "server.notice.rulesNotSaved":
    "This call is allowed until this project's rules change: its always rule could not be saved.",
  "server.notice.viewNotRefreshed": "The view could not be refreshed. Reload the page.",
  "server.cause.stopped": "Agent process stopped.",
  "server.cause.exitCode": "Agent process exited with code {code}.",
  "server.cause.signal": "Agent process stopped by {signal}.",
  "server.cause.signalUnknown": "Agent process stopped by a signal.",
  "server.cause.killed": "Agent process killed (SIGKILL), possibly out of memory.",
  "server.cause.oom": "Agent process ran out of memory and was stopped.",
  "server.cause.spawnFailure": "Agent process could not start.",
  "server.notice.agentModelRefused":
    "This agent's model {model} is not offered to its worker: it runs on {running} instead. Settings › Models › Available models decides what is offered.",
  "server.notice.agentModelRefusedDefault":
    "This agent's model {model} is not offered to its worker: it runs on Pi's default model instead. Settings › Models › Available models decides what is offered.",
  "server.notice.agentModelRefusedChat":
    "This agent uses Chat only, which loads no extension: its model {model} is not offered there, so it runs on another model. Choose a model Pi has, or another tool preset.",
  "server.notice.agentModelNotApplied":
    "This agent's model {model} could not be applied when its worker started, so it runs on another model. Settings › Models shows the provider's state.",
} as const;

export const serverFr: { readonly [K in keyof typeof serverEn]: string } = {
  "server.notice.messageTooLarge": "Un message était trop volumineux pour être diffusé.",
  "server.notice.dialogTooLarge":
    "Une extension a posé une question trop volumineuse pour être affichée. Elle a été annulée.",
  "server.notice.dialogLimit":
    "Une extension a posé une question alors que trop d'autres attendaient. Elle a été annulée.",
  "server.notice.approvalUnshown":
    "Une question sur l'appel d'un outil n'a pas pu être affichée. L'appel a été bloqué.",
  "server.notice.extensionFailed": "Une extension a échoué.",
  "server.notice.extensionFailedDuring": "Une extension a échoué pendant {event}.",
  "server.notice.panelsLimit": "Une extension a ouvert trop de panneaux. Le panneau en trop a été annulé.",
  "server.notice.heldOne": "1 autre notification d'extension n'a pas été affichée.",
  "server.notice.heldMany": "{count} autres notifications d'extensions n'ont pas été affichées.",
  "server.notice.rulesFull":
    "Ce projet a déjà {max} appels toujours autorisés : celui-ci est autorisé jusqu'à ce que les règles du projet changent.",
  "server.notice.rulesNotSaved":
    "Cet appel est autorisé jusqu'à ce que les règles du projet changent : sa règle « toujours » n'a pas pu être enregistrée.",
  "server.notice.viewNotRefreshed": "L'affichage n'a pas pu être actualisé. Rechargez la page.",
  "server.cause.stopped": "Le processus de l'agent s'est arrêté.",
  "server.cause.exitCode": "Le processus de l'agent s'est arrêté avec le code {code}.",
  "server.cause.signal": "Le processus de l'agent a été arrêté par {signal}.",
  "server.cause.signalUnknown": "Le processus de l'agent a été arrêté par un signal.",
  "server.cause.killed": "Le processus de l'agent a été tué (SIGKILL), peut-être faute de mémoire.",
  "server.cause.oom": "Le processus de l'agent a manqué de mémoire et a été arrêté.",
  "server.cause.spawnFailure": "Le processus de l'agent n'a pas pu démarrer.",
  "server.notice.agentModelRefused":
    "Le modèle de cet agent, {model}, n'est pas proposé à son processus : il s'exécute avec {running} à la place. Réglages › Modèles › Modèles proposés décide de ce qui est proposé.",
  "server.notice.agentModelRefusedDefault":
    "Le modèle de cet agent, {model}, n'est pas proposé à son processus : il s'exécute avec le modèle par défaut de Pi à la place. Réglages › Modèles › Modèles proposés décide de ce qui est proposé.",
  "server.notice.agentModelRefusedChat":
    "Cet agent utilise Chat seul, qui ne charge aucune extension : son modèle, {model}, n'y est pas proposé, il s'exécute donc avec un autre modèle. Choisissez un modèle de Pi, ou un autre préréglage d'outils.",
  "server.notice.agentModelNotApplied":
    "Le modèle de cet agent, {model}, n'a pas pu être appliqué au démarrage de son processus : il s'exécute donc avec un autre modèle. Réglages › Modèles montre l'état du fournisseur.",
};
