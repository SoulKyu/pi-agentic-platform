// Project trust (`trust.*`). Lazy: the banner's four lines load with the session screen (`features/trust/register-banner-catalog.ts`),
// the dialog's with its own chunk (`features/trust/register-dialog-catalog.ts`).
export const trustBannerEn = {
  "trust.banner.title": "This project has Pi resources pap does not load until you trust it.",
  "trust.banner.review": "Review",
  "trust.banner.trusted":
    "Trusted. This applies when Pi restarts for the session: right away if it is idle, after its run if it is running.",
  "trust.banner.untrusted":
    "Kept untrusted. This applies when Pi restarts for the session: right away if it is idle, after its run if it is running.",
} as const;

export const trustBannerFr: { readonly [K in keyof typeof trustBannerEn]: string } = {
  "trust.banner.title":
    "Ce projet a des ressources Pi que pap ne charge pas tant que vous ne lui faites pas confiance.",
  "trust.banner.review": "Examiner",
  "trust.banner.trusted":
    "Projet de confiance. Cela s'applique au redémarrage de Pi pour la session : tout de suite si elle est inactive, après son exécution si elle tourne.",
  "trust.banner.untrusted":
    "Projet laissé non fiable. Cela s'applique au redémarrage de Pi pour la session : tout de suite si elle est inactive, après son exécution si elle tourne.",
};

export const trustEn = {
  "trust.dialog.title": "Trust this project?",
  "trust.dialog.description":
    "Trusting lets Pi load what this project brings. It runs with your permissions.",
  "trust.dialog.close": "Close",
  "trust.folder": "Folder: {path}",
  "trust.loading": "Reading the project…",
  "trust.retry": "Try again",
  "trust.current.trusted": "Current decision: trusted.",
  "trust.current.untrusted": "Current decision: not trusted.",
  "trust.current.none": "No decision yet.",
  "trust.current.inherited": "It comes from {path}, a folder above.",
  "trust.resources.title": "Trusting turns this on",
  "trust.resources.external": "These names come from the project, not from pap.",
  "trust.nothing": "pap found nothing to turn on.",
  "trust.mcp": "MCP servers ({count})",
  "trust.mcp.sends": "sends {names} to this server",
  "trust.mcp.command": "runs a command for {fields}",
  "trust.extensions": "Extensions ({count})",
  "trust.extensions.note": "Code that runs inside Pi.",
  "trust.skills": "Skills ({count})",
  "trust.templates": "Prompt templates: {count}",
  "trust.settings": "Settings it sets (names only): {keys}",
  "trust.systemPrompt": "It replaces or extends the system prompt (SYSTEM.md or APPEND_SYSTEM.md).",
  "trust.incomplete.title": "pap could not list everything",
  "trust.incomplete.body": "Pi may load more than what is shown here.",
  "trust.incomplete.cut": "Some lists were cut.",
  "trust.restart":
    "A decision applies when Pi restarts for the session: right away for an idle one, after its run for a running one. This covers the sessions of this folder and below.",
  "trust.unknown":
    "The answer did not arrive, so pap does not know whether the decision was saved. The current decision above was read again.",
  "trust.action.trust": "Trust",
  "trust.action.keep": "Keep untrusted",
  "trust.action.cancel": "Cancel",
  "trust.refusal.filesystem-root":
    "Trusting the whole disk would trust every folder on it. Choose a project folder.",
  "trust.refusal.home-or-above":
    "Trusting your home folder, or one above it, would trust everything below it. Choose a project folder.",
  "trust.refusal.holds-pi-or-pap":
    "This folder holds Pi's own folder or pap's, so trusting it would trust their contents. Choose a project folder.",
  "trust.refusal.holds-other-projects":
    "This folder holds other projects, so trusting it would trust them all. Trust each project on its own.",
  "trust.refusal.inside-pap-home":
    "This folder is inside pap's data folder, where agents write. Trusting it would load what an agent wrote. Configure the agent in its profile instead.",
} as const;

export const trustFr: { readonly [K in keyof typeof trustEn]: string } = {
  "trust.dialog.title": "Faire confiance à ce projet ?",
  "trust.dialog.description":
    "Faire confiance permet à Pi de charger ce que le projet apporte. Cela s'exécute avec vos permissions.",
  "trust.dialog.close": "Fermer",
  "trust.folder": "Dossier : {path}",
  "trust.loading": "Lecture du projet…",
  "trust.retry": "Réessayer",
  "trust.current.trusted": "Décision actuelle : de confiance.",
  "trust.current.untrusted": "Décision actuelle : non fiable.",
  "trust.current.none": "Pas encore de décision.",
  "trust.current.inherited": "Elle vient de {path}, un dossier au-dessus.",
  "trust.resources.title": "Faire confiance active ceci",
  "trust.resources.external": "Ces noms viennent du projet, pas de pap.",
  "trust.nothing": "pap n'a rien trouvé à activer.",
  "trust.mcp": "Serveurs MCP ({count})",
  "trust.mcp.sends": "envoie {names} à ce serveur",
  "trust.mcp.command": "exécute une commande pour {fields}",
  "trust.extensions": "Extensions ({count})",
  "trust.extensions.note": "Du code qui s'exécute dans Pi.",
  "trust.skills": "Skills ({count})",
  "trust.templates": "Modèles de prompt : {count}",
  "trust.settings": "Réglages qu'il définit (noms seulement) : {keys}",
  "trust.systemPrompt": "Il remplace ou complète le prompt système (SYSTEM.md ou APPEND_SYSTEM.md).",
  "trust.incomplete.title": "pap n'a pas pu tout lister",
  "trust.incomplete.body": "Pi peut charger plus que ce qui est montré ici.",
  "trust.incomplete.cut": "Certaines listes ont été coupées.",
  "trust.restart":
    "Une décision s'applique au redémarrage de Pi pour la session : tout de suite pour une session inactive, après son exécution pour une session qui tourne. Cela couvre les sessions de ce dossier et de ceux en dessous.",
  "trust.unknown":
    "La réponse n'est pas arrivée, donc pap ne sait pas si la décision a été enregistrée. La décision actuelle ci-dessus a été relue.",
  "trust.action.trust": "Faire confiance",
  "trust.action.keep": "Rester non fiable",
  "trust.action.cancel": "Annuler",
  "trust.refusal.filesystem-root":
    "Faire confiance à tout le disque ferait confiance à tous ses dossiers. Choisissez un dossier de projet.",
  "trust.refusal.home-or-above":
    "Faire confiance à votre dossier personnel, ou à un dossier au-dessus, ferait confiance à tout ce qu'il contient. Choisissez un dossier de projet.",
  "trust.refusal.holds-pi-or-pap":
    "Ce dossier contient celui de Pi ou celui de pap : lui faire confiance ferait confiance à leur contenu. Choisissez un dossier de projet.",
  "trust.refusal.holds-other-projects":
    "Ce dossier contient d'autres projets : lui faire confiance leur ferait tous confiance. Faites confiance à chaque projet séparément.",
  "trust.refusal.inside-pap-home":
    "Ce dossier est dans le dossier de données de pap, où les agents écrivent. Lui faire confiance chargerait ce qu'un agent a écrit. Configurez plutôt l'agent dans son profil.",
};
