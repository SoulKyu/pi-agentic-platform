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
  "settings.agents.back": "All agents",
  "settings.agents.saved": "Agent saved.",
  "settings.agents.changedElsewhere": "This agent changed elsewhere; your edits were not saved.",
  "settings.agents.detail.loading": "Loading {name}…",
  "settings.agents.detail.failed": "This agent could not be read.",
  "settings.agents.detail.gone": "This agent no longer exists.",
  "settings.agents.detail.unreadable":
    "This agent's saved profile cannot be read, so it cannot be edited here. It stays paused.",
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
  "settings.agents.back": "Tous les agents",
  "settings.agents.saved": "Agent enregistré.",
  "settings.agents.changedElsewhere":
    "Cet agent a changé ailleurs ; vos modifications n'ont pas été enregistrées.",
  "settings.agents.detail.loading": "Chargement de {name}…",
  "settings.agents.detail.failed": "Cet agent n'a pas pu être lu.",
  "settings.agents.detail.gone": "Cet agent n'existe plus.",
  "settings.agents.detail.unreadable":
    "Le profil enregistré de cet agent est illisible, il ne peut donc pas être modifié ici. Il reste en pause.",
};
