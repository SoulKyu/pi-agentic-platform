// The refused-host card in the agent's thread and its add dialog (agents in microVMs, sub-project 2). Lazy: registered by
// `features/agents/register-space-catalog.ts`. The names are pap's; the host is shown as data, in mono.
export const agentEgressEn = {
  "agentEgress.chip": "Blocked",
  "agentEgress.someone": "an agent",
  "agentEgress.card.title": "Blocked host",
  "agentEgress.card.not_listed":
    "@{name} could not reach {host}:{port}: it is not in its host list. Nothing left the VM.",
  "agentEgress.card.private_wildcard":
    "@{name} could not reach {host}:{port}: it points to a private address, which only an exact entry reaches. Nothing left the VM.",
  "agentEgress.card.blocked_address":
    "@{name} could not reach {host}:{port}: the address it points to is always refused. Nothing left the VM.",
  "agentEgress.card.always": "pap always refuses this address: it cannot be added to a list.",
  "agentEgress.card.count": "{count} attempts",
  "agentEgress.add": "Add…",
  "agentEgress.d.title": "Add {host}:{port} to the host list?",
  "agentEgress.d.hostLabel": "Host and port",
  "agentEgress.d.attempts": "Attempts",
  "agentEgress.d.attemptsLine": "{count} · last at {time} · from {vm}",
  "agentEgress.d.vm.thread": "thread",
  "agentEgress.d.vm.task": "task {task}",
  "agentEgress.d.private": "{address} · this name comes from the agent; add it only if you know it",
  "agentEgress.d.scope": "For this agent only, from its next request. Nothing is retried for you.",
  "agentEgress.d.copy":
    "@{name} uses your list. It gets its own copy of it plus this host. Your list and the other agents are not changed.",
  "agentEgress.d.add": "Add to list",
  "agentEgress.d.added": "{host}:{port} added to @{name}'s list.",
  "agentEgress.d.conflict": "@{name} changed while this was open. Nothing was added: open the card again.",
  "agentEgress.d.full":
    "@{name}'s list would pass {max} entries. Nothing was added and the agent is unchanged: remove a host from its list in the agent form, then add this one.",
} as const;

export const agentEgressFr: Record<keyof typeof agentEgressEn, string> = {
  "agentEgress.chip": "Bloqué",
  "agentEgress.someone": "un agent",
  "agentEgress.card.title": "Hôte bloqué",
  "agentEgress.card.not_listed":
    "@{name} n'a pas pu joindre {host}:{port} : il n'est pas dans sa liste d'hôtes. Rien n'est sorti de la VM.",
  "agentEgress.card.private_wildcard":
    "@{name} n'a pas pu joindre {host}:{port} : il pointe vers une adresse privée, que seule une entrée exacte atteint. Rien n'est sorti de la VM.",
  "agentEgress.card.blocked_address":
    "@{name} n'a pas pu joindre {host}:{port} : l'adresse vers laquelle il pointe est toujours refusée. Rien n'est sorti de la VM.",
  "agentEgress.card.always": "pap refuse toujours cette adresse : elle ne peut pas être ajoutée à une liste.",
  "agentEgress.card.count": "{count} tentatives",
  "agentEgress.add": "Ajouter…",
  "agentEgress.d.title": "Ajouter {host}:{port} à la liste d'hôtes ?",
  "agentEgress.d.hostLabel": "Hôte et port",
  "agentEgress.d.attempts": "Tentatives",
  "agentEgress.d.attemptsLine": "{count} · dernière à {time} · depuis {vm}",
  "agentEgress.d.vm.thread": "le fil",
  "agentEgress.d.vm.task": "la tâche {task}",
  "agentEgress.d.private": "{address} · ce nom vient de l'agent ; ne l'ajoutez que si vous le connaissez",
  "agentEgress.d.scope":
    "Pour cet agent seulement, dès sa prochaine requête. Rien n'est relancé à votre place.",
  "agentEgress.d.copy":
    "@{name} utilise votre liste. Il en reçoit une copie à lui, plus cet hôte. Votre liste et les autres agents ne changent pas.",
  "agentEgress.d.add": "Ajouter à la liste",
  "agentEgress.d.added": "{host}:{port} ajouté à la liste de @{name}.",
  "agentEgress.d.conflict":
    "@{name} a changé pendant que cette fenêtre était ouverte. Rien n'a été ajouté : rouvrez la carte.",
  "agentEgress.d.full":
    "La liste de @{name} dépasserait {max} entrées. Rien n'a été ajouté et l'agent n'a pas changé : retirez un hôte de sa liste dans le formulaire de l'agent, puis ajoutez celui-ci.",
};
