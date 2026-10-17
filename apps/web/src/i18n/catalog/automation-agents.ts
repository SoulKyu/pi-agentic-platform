// Lazy: the trigger editor's "Runs as" and the Tasks board's agent columns (`register-automation*.ts`, in both lazy chunks).
export const automationAgentsEn = {
  "automation.editor.runsAs": "Runs as",
  "automation.editor.runsAs.project": "Project folder",
  "automation.editor.runsAs.agent": "Agent",
  "automation.editor.agent": "Agent",
  "automation.editor.target.thread.line": "in {name}'s thread, with its tools",
  "automation.editor.target.isolated.line":
    "in a fresh session in {name}'s home, with this tool list, unattended, in its sandbox",
  "automation.editor.target.outside":
    "A webhook or a feed runs as an isolated task only: outside text never reaches an agent's thread.",
  "automation.editor.precheck.agent":
    "The precheck always runs in the agent's sandbox. On a host without a usable bwrap, every agent precheck is refused (sandbox unavailable).",
  "automation.editor.threadPrecheck":
    "A thread trigger cannot use {{precheck}}: the precheck's output is outside text and the thread is the agent's trusted context. Run it as an isolated task to quote it.",
  "automation.dry.isolatedTask":
    "isolated-task · sandbox {state} · home read-only, writes in a scratch folder",
  "automation.dry.sandbox.on": "on",
  "automation.dry.sandbox.unavailable": "unavailable (no usable bwrap)",
  "automation.dry.sandbox.checking": "being checked",
  "automation.dry.sandbox.unread": "could not be read",
  "automation.reason.thread_unavailable": "the agent's thread was not available",
  "automation.reason.sandbox_unavailable": "no usable sandbox on this host",
  "automation.reason.quarantined": "agent quarantined",
  "automation.card.target.thread": "In thread",
  "automation.card.target.isolated": "Isolated task",
  "automation.card.requestedBy": "requested by {name}",
};

export const automationAgentsFr: Record<keyof typeof automationAgentsEn, string> = {
  "automation.editor.runsAs": "S'exécute comme",
  "automation.editor.runsAs.project": "Dossier de projet",
  "automation.editor.runsAs.agent": "Agent",
  "automation.editor.agent": "Agent",
  "automation.editor.target.thread.line": "dans le thread de {name}, avec ses outils",
  "automation.editor.target.isolated.line":
    "dans une session neuve dans le dossier personnel de {name}, avec cette liste d'outils, sans surveillance, dans son bac à sable",
  "automation.editor.target.outside":
    "Un webhook ou un flux ne s'exécute qu'en tâche isolée : un texte venu de l'extérieur n'atteint jamais le thread d'un agent.",
  "automation.editor.precheck.agent":
    "Le precheck s'exécute toujours dans le bac à sable de l'agent. Sur un hôte sans bwrap utilisable, tout precheck d'agent est refusé (bac à sable indisponible).",
  "automation.editor.threadPrecheck":
    "Un déclencheur de thread ne peut pas utiliser {{precheck}} : la sortie du precheck est un texte extérieur et le thread est le contexte de confiance de l'agent. Lancez-le en tâche isolée pour la citer.",
  "automation.dry.isolatedTask":
    "isolated-task · bac à sable {state} · dossier personnel en lecture seule, écritures dans un dossier temporaire",
  "automation.dry.sandbox.on": "actif",
  "automation.dry.sandbox.unavailable": "indisponible (pas de bwrap utilisable)",
  "automation.dry.sandbox.checking": "en cours de vérification",
  "automation.dry.sandbox.unread": "illisible",
  "automation.reason.thread_unavailable": "le thread de l'agent n'était pas disponible",
  "automation.reason.sandbox_unavailable": "pas de bac à sable utilisable sur cet hôte",
  "automation.reason.quarantined": "agent en quarantaine",
  "automation.card.target.thread": "Dans le thread",
  "automation.card.target.isolated": "Tâche isolée",
  "automation.card.requestedBy": "demandé par {name}",
};
