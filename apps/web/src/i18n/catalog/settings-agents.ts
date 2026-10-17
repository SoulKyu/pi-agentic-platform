// Settings › Agents and Settings › Appearance › Agents (M11R97, M11R98). Registered by `features/agents/register-agent-catalog.ts`
// and by the Settings chunk.
export const settingsAgentsEn = {
  "settings.appearance.agents.title": "Agents",
  "settings.appearance.agents.eventCards": "Event cards",
  "settings.appearance.agents.eventCards.cards": "Cards",
  "settings.appearance.agents.eventCards.compact": "Compact",
  "settings.appearance.agents.eventCards.hint": "Compact shows one timeline line per card.",
  "settings.appearance.agents.statusPanel": "Status panel",
  "settings.appearance.agents.statusPanel.shown": "Shown",
  "settings.appearance.agents.statusPanel.hidden": "Hidden",
  "settings.appearance.agents.statusPanel.hint": "Hidden leaves a toggle in the agent header.",
  "settings.agents.intro": "Named assistants with their own home, memory and limits.",
  "settings.agents.list": "Your agents",
  "settings.agents.new": "New agent",
  "settings.agents.loading": "Loading agents…",
  "settings.agents.empty": "No agent yet. Create one to give it a home, a role and limits.",
  "settings.agents.feedFailed": "The agents list could not be read. Reload the page to try again.",
  "settings.agents.open": "Open",
  "settings.agents.openNamed": "Open {name}",
  "settings.agents.state.needs_input": "Needs you",
  "settings.agents.state.running": "Running",
  "settings.agents.state.failed": "Failed",
  "settings.agents.state.paused": "Paused",
  "settings.agents.state.idle": "Idle",
  "settings.agents.state.quarantined": "Quarantined",
  "settings.agents.back": "All agents",
  "settings.agents.saved": "Agent saved.",
  "settings.agents.changedElsewhere": "This agent changed elsewhere; your edits were not saved.",
  "settings.agents.detail.loading": "Loading {name}…",
  "settings.agents.detail.failed": "This agent could not be read.",
  "settings.agents.detail.gone": "This agent no longer exists.",
  "settings.agents.detail.unreadable":
    "This agent's saved profile cannot be read, so it cannot be edited here. It stays paused.",
  "agentsSandbox.title": "Sandbox",
  "agentsSandbox.checking": "Checking the sandbox…",
  "agentsSandbox.usable": "Ready: bubblewrap at {path}",
  "agentsSandbox.unusable": "Not usable:",
  "agentsSandbox.reason.missing": "bubblewrap is not installed:",
  "agentsSandbox.reason.missing.command": "sudo apt install bubblewrap",
  "agentsSandbox.reason.unsafe_path": "this binary is not owned by root",
  "agentsSandbox.reason.refused": "user namespaces are refused for it (AppArmor)",
  "agentsSandbox.reason.timeout": "it did not answer in 5 s",
  "agentsSandbox.readFailed": "The sandbox state could not be read.",
  "agentsSandbox.slow": "The first check is taking longer than usual. Use Check again.",
  "agentsSandbox.recheck": "Check again",
  "agentsSandbox.rechecking": "Checking…",
  "agentsSandbox.rateLimited": "Checked a moment ago: try again in a few seconds.",
  "agentsSandbox.recheckFailed": "The check could not run. Try again.",
  "agentsSandbox.sees.title": "What an agent's shell sees",
  "agentsSandbox.sees.thread":
    "A thread: the system, minus your home, pap's and Pi's folders, the system logs, crash dumps and /var/tmp. Its own home is writable.",
  "agentsSandbox.sees.task":
    "An isolated task: the system folders, its home read-only, and its scratch folder to write in.",
  "agentsSandbox.sees.home": "Neither sees any folder of your home.",
  "agentsSandbox.gaps.title": "What the sandbox does not cover",
  "agentsSandbox.gaps.worker":
    "The worker itself (Pi, its extensions, MCP stdio servers) runs outside the sandbox, as you.",
  "agentsSandbox.gaps.fileTools":
    "read, edit, write, grep, find and ls are held back by pap's path rules, not by the sandbox. A thread's read, grep, find and ls are refused outside its home, its own runs folder (its isolated tasks' output, read as external content), the files attached to the thread, Pi's skills (read-only) and the system folders: your home is out of reach for them too.",
  "agentsSandbox.gaps.network":
    "With network on, the shell reaches only what pap's egress proxy lets through: your host list, the trusted sources and the hosts you allow in the thread. pap guarantees the hosts, not the content.",
  "agentsSandbox.gaps.proc":
    "Other processes of your user, outside the sandbox, can read the sandbox's environment through /proc.",
  "agentsSandbox.gaps.threadReach":
    "An agent thread's shell reads everything you can read outside the hidden folders (other mounts, /srv, most of /var, other users' readable files). Only an isolated task is limited to the system folders.",
  "agentsSandbox.gaps.tools": "The shell has no node, rg or fd unless they are installed system-wide.",
} as const;

export const settingsAgentsFr: Record<keyof typeof settingsAgentsEn, string> = {
  "settings.appearance.agents.title": "Agents",
  "settings.appearance.agents.eventCards": "Cartes d'événements",
  "settings.appearance.agents.eventCards.cards": "Cartes",
  "settings.appearance.agents.eventCards.compact": "Compact",
  "settings.appearance.agents.eventCards.hint": "Compact montre une ligne de chronologie par carte.",
  "settings.appearance.agents.statusPanel": "Panneau d'état",
  "settings.appearance.agents.statusPanel.shown": "Affiché",
  "settings.appearance.agents.statusPanel.hidden": "Masqué",
  "settings.appearance.agents.statusPanel.hint": "Masqué laisse un interrupteur dans l'en-tête de l'agent.",
  "settings.agents.intro":
    "Des assistants nommés, avec leur propre dossier personnel, leur mémoire et leurs limites.",
  "settings.agents.list": "Vos agents",
  "settings.agents.new": "Nouvel agent",
  "settings.agents.loading": "Chargement des agents…",
  "settings.agents.empty": "Aucun agent. Créez-en un pour lui donner un dossier, un rôle et des limites.",
  "settings.agents.feedFailed": "La liste des agents n'a pas pu être lue. Rechargez la page pour réessayer.",
  "settings.agents.open": "Ouvrir",
  "settings.agents.openNamed": "Ouvrir {name}",
  "settings.agents.state.needs_input": "Attend votre réponse",
  "settings.agents.state.running": "En cours",
  "settings.agents.state.failed": "Échec",
  "settings.agents.state.paused": "En pause",
  "settings.agents.state.idle": "Au repos",
  "settings.agents.state.quarantined": "En quarantaine",
  "settings.agents.back": "Tous les agents",
  "settings.agents.saved": "Agent enregistré.",
  "settings.agents.changedElsewhere":
    "Cet agent a changé ailleurs ; vos modifications n'ont pas été enregistrées.",
  "settings.agents.detail.loading": "Chargement de {name}…",
  "settings.agents.detail.failed": "Cet agent n'a pas pu être lu.",
  "settings.agents.detail.gone": "Cet agent n'existe plus.",
  "settings.agents.detail.unreadable":
    "Le profil enregistré de cet agent est illisible, il ne peut donc pas être modifié ici. Il reste en pause.",
  "agentsSandbox.title": "Bac à sable",
  "agentsSandbox.checking": "Vérification du bac à sable…",
  "agentsSandbox.usable": "Prêt : bubblewrap dans {path}",
  "agentsSandbox.unusable": "Inutilisable :",
  "agentsSandbox.reason.missing": "bubblewrap n'est pas installé :",
  "agentsSandbox.reason.missing.command": "sudo apt install bubblewrap",
  "agentsSandbox.reason.unsafe_path": "ce binaire n'appartient pas à root",
  "agentsSandbox.reason.refused": "les espaces de noms utilisateur lui sont refusés (AppArmor)",
  "agentsSandbox.reason.timeout": "il n'a pas répondu en 5 s",
  "agentsSandbox.readFailed": "L'état du bac à sable n'a pas pu être lu.",
  "agentsSandbox.slow":
    "La première vérification prend plus de temps que d'habitude. Utilisez « Vérifier à nouveau ».",
  "agentsSandbox.recheck": "Vérifier à nouveau",
  "agentsSandbox.rechecking": "Vérification…",
  "agentsSandbox.rateLimited": "Vérifié à l'instant : réessayez dans quelques secondes.",
  "agentsSandbox.recheckFailed": "La vérification n'a pas pu s'exécuter. Réessayez.",
  "agentsSandbox.sees.title": "Ce que voit le shell d'un agent",
  "agentsSandbox.sees.thread":
    "Un fil : le système, sans votre dossier personnel, ceux de pap et de Pi, les journaux système, les vidages d'erreurs (crash dumps) et /var/tmp. Son propre dossier est modifiable.",
  "agentsSandbox.sees.task":
    "Une tâche isolée : les dossiers système, son dossier en lecture seule, et son dossier de travail où écrire.",
  "agentsSandbox.sees.home": "Ni l'un ni l'autre ne voit un dossier de votre dossier personnel.",
  "agentsSandbox.gaps.title": "Ce que le bac à sable ne couvre pas",
  "agentsSandbox.gaps.worker":
    "Le worker lui-même (Pi, ses extensions, les serveurs MCP stdio) tourne hors du bac à sable, sous votre identité.",
  "agentsSandbox.gaps.fileTools":
    "read, edit, write, grep, find et ls sont retenus par les règles de chemins de pap, pas par le bac à sable. Les outils read, grep, find et ls d'un fil sont refusés hors de son dossier, de son dossier d'exécutions (la sortie de ses tâches isolées, lue comme contenu externe), des fichiers joints au fil, des skills de Pi (en lecture seule) et des dossiers système : votre dossier personnel leur est aussi inaccessible.",
  "agentsSandbox.gaps.network":
    "Avec le réseau, le shell ne joint que ce que le proxy de sortie de pap laisse passer : votre liste d'hôtes, les sources de confiance et les hôtes que vous autorisez dans le fil. pap garantit les hôtes, pas le contenu.",
  "agentsSandbox.gaps.proc":
    "D'autres processus de votre utilisateur, hors du bac à sable, peuvent lire son environnement via /proc.",
  "agentsSandbox.gaps.threadReach":
    "Le shell d'un fil d'agent lit tout ce que vous pouvez lire hors des dossiers masqués (autres montages, /srv, l'essentiel de /var, fichiers lisibles d'autres utilisateurs). Seule une tâche isolée est limitée aux dossiers système.",
  "agentsSandbox.gaps.tools":
    "Le shell n'a pas node, rg ni fd, sauf s'ils sont installés pour tout le système.",
};
