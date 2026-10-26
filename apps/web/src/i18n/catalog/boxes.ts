/** Box projects (boxes lot B1): the box fact, the stopped panels, the project settings. Registered by register-boxes.ts. */
export const boxesEn = {
  "boxes.label": "Box",
  "boxes.phase.stopped": "Stopped",
  "boxes.phase.starting": "Starting",
  "boxes.phase.running": "Running",
  "boxes.start": "Start",
  "boxes.stage": "Starting the box…",
  "boxes.agentStage": "Starting the agent's VM…",
  "boxes.packagesChanged": "Packages changed",
  "boxes.stopped.title": "Box stopped",
  "boxes.stopped.purpose": "The project's box is stopped. Start it to see its files.",
  "boxes.stopped.agent.title": "VM stopped",
  "boxes.stopped.agent.purpose": "The agent's VM is stopped. Start it to see its files.",
  "boxes.off": "Not available in a box yet.",
  "boxes.noBackup": "This project's files live only in its box: push them to keep a copy.",
  "boxes.settings": "Project settings",
  "boxes.settings.loading": "Reading the box settings…",
  "boxes.settings.failed": "The box settings could not be read. Nothing changed. Close this and try again.",
  "boxes.settings.save": "Save",
  "boxes.settings.saved": "Box settings saved.",
  "boxes.section.box": "Box",
  "boxes.section.resources": "Resources",
  "boxes.section.hosts": "Hosts",
  "boxes.section.packages": "Packages",
  "boxes.resources.hint": "They apply at the next start of the box.",
  "boxes.hosts.field": "Hosts, one per line",
  "boxes.hosts.hint":
    "These hosts belong to this project. Its box reaches them on top of your own list (Settings › Policy). *.example.com covers subdomains. Also host:port (default 80 and 443) and IPs.",
  "boxes.hosts.error": "Host names (api.example.com or *.example.com), or host:port and IPs, 256 at most.",
  "boxes.packages.built": "In the box image",
  "boxes.packages.wanted": "Asked by .pi/project.yaml",
  "boxes.packages.none": "No extra package in the box image.",
  "boxes.packages.noneWanted": "No package asked.",
  "boxes.packages.notice":
    ".pi/project.yaml asks for other packages than the box image. Rebuild to install them; the new image applies at the next start.",
  "boxes.rebuild": "Rebuild",
  "boxes.restart": "Restart box",
  "boxes.delete": "Delete project",
  "boxes.delete.title": "Delete project",
  "boxes.delete.confirm":
    "Delete {name}? Its box, {sessions} sessions and {triggers} triggers go. The disk stays in the trash for 7 days.",
  "boxes.inbox.title": "Project box paused after 3 crashes",
  "boxes.inbox.open": "Open project {name}",
  "boxes.inbox.chip": "Paused",
  "boxes.picker.scratch": "Scratch",
  "boxes.picker.scratchHint": "An empty project for quick sessions.",
  "boxes.settings.heading": "Project settings · {name}",
  "boxes.error.capacity":
    "The box could not start: the server is at capacity. Your files are intact. Stop another box or agent, then try again.",
  "boxes.error.sandbox_unavailable":
    "The box could not start: this machine has no microVM support set up. Your files are intact. Run `sudo pap vm setup` on the server, then try again.",
  "boxes.error.disk_low":
    "The action was refused: the disk is almost full. Your files are intact. Free some space on the server, then try again.",
  "boxes.error.command_failed":
    "The box did not complete the action. Your files are intact. Try again; if it fails again, run `pap doctor`.",
  "boxes.error.not_found":
    "This project no longer exists. Nothing was changed. Close this window and pick another project.",
  "boxes.error.bad_request":
    "These settings are not accepted. Nothing was changed. Check the values shown, then save again.",
  "boxes.error.read_only":
    "The database was written by a newer pap and is read-only. Nothing was changed. Update pap to change this.",
  "boxes.error.internal":
    "Something went wrong and the action did not complete. Your files are intact. Try again.",
  "boxes.error.conflict":
    "The project was not deleted: it changed while you were asking. Nothing was removed. Check the project, then try again.",
  "boxes.error.conflictScratch":
    "Scratch was not deleted: it still holds sessions. Nothing was removed. Delete or archive its sessions, then try again.",
  "boxes.error.vm_bundle_stale":
    "The box could not start: its code is older than pap. Your files are intact. Run `sudo pap vm setup` on the server, then start the box again.",
  "boxes.error.agent_paused":
    "The box crashed 3 times in 10 minutes and is paused. Your files are intact. Fix the cause if you know it, then restart the box.",
  "boxes.agentError.not_found":
    "This agent no longer exists or its profile cannot be read, so there is no VM to start. Nothing was changed. Check Settings › Agents.",
  "boxes.agentError.capacity":
    "The agent's VM could not start: the server is at capacity. Its files are intact. Stop another box or agent, then try again.",
  "boxes.agentError.agent_paused":
    "The agent is paused or quarantined, so its VM was not started. Its files are intact. Resume it (Settings tab for a quarantined agent, header for a paused one), then start the VM.",
  "boxes.agentError.vm_bundle_stale":
    "The agent's VM could not start: its code is older than pap. Its files are intact. Run `sudo pap vm setup` on the server, then start the VM again.",
  "boxes.agentError.sandbox_unavailable":
    "The agent's VM could not start: this machine has no microVM support set up. Its files are intact. Run `sudo pap vm setup` on the server, then try again.",
  "boxes.agentError.disk_low":
    "The agent's VM was not started: the disk is almost full. Its files are intact. Free some space on the server, then try again.",
  "boxes.agentError.fallback":
    "The agent's VM could not start. Its files are intact. Try again; if it fails again, run `pap doctor`.",
} as const;

export const boxesFr: { readonly [K in keyof typeof boxesEn]: string } = {
  "boxes.label": "Box",
  "boxes.phase.stopped": "Arrêtée",
  "boxes.phase.starting": "Démarrage",
  "boxes.phase.running": "En marche",
  "boxes.start": "Démarrer",
  "boxes.stage": "Démarrage de la box…",
  "boxes.agentStage": "Démarrage de la VM de l'agent…",
  "boxes.packagesChanged": "Paquets modifiés",
  "boxes.stopped.title": "Box arrêtée",
  "boxes.stopped.purpose": "La box du projet est arrêtée. Démarrez-la pour voir ses fichiers.",
  "boxes.stopped.agent.title": "VM arrêtée",
  "boxes.stopped.agent.purpose": "La VM de l'agent est arrêtée. Démarrez-la pour voir ses fichiers.",
  "boxes.off": "Pas encore disponible dans une box.",
  "boxes.noBackup":
    "Les fichiers de ce projet ne vivent que dans sa box : poussez-les pour en garder une copie.",
  "boxes.settings": "Réglages du projet",
  "boxes.settings.loading": "Lecture des réglages de la box…",
  "boxes.settings.failed":
    "Les réglages de la box n'ont pas pu être lus. Rien n'a changé. Fermez et réessayez.",
  "boxes.settings.save": "Enregistrer",
  "boxes.settings.saved": "Réglages de la box enregistrés.",
  "boxes.section.box": "Box",
  "boxes.section.resources": "Ressources",
  "boxes.section.hosts": "Hôtes",
  "boxes.section.packages": "Paquets",
  "boxes.resources.hint": "Ils s'appliquent au prochain démarrage de la box.",
  "boxes.hosts.field": "Hôtes, un par ligne",
  "boxes.hosts.hint":
    "Ces hôtes appartiennent à ce projet. Sa box les atteint en plus de votre propre liste (Réglages › Politique). *.example.com couvre les sous-domaines. Aussi host:port (80 et 443 par défaut) et les IP.",
  "boxes.hosts.error":
    "Des noms d'hôte (api.example.com ou *.example.com), ou host:port et des IP, 256 au plus.",
  "boxes.packages.built": "Dans l'image de la box",
  "boxes.packages.wanted": "Demandés par .pi/project.yaml",
  "boxes.packages.none": "Aucun paquet supplémentaire dans l'image de la box.",
  "boxes.packages.noneWanted": "Aucun paquet demandé.",
  "boxes.packages.notice":
    ".pi/project.yaml demande d'autres paquets que l'image de la box. Reconstruisez pour les installer ; la nouvelle image s'applique au prochain démarrage.",
  "boxes.rebuild": "Reconstruire",
  "boxes.restart": "Redémarrer la box",
  "boxes.delete": "Supprimer le projet",
  "boxes.delete.title": "Supprimer le projet",
  "boxes.delete.confirm":
    "Supprimer {name} ? Sa box, {sessions} sessions et {triggers} déclencheurs disparaissent. Le disque reste 7 jours dans la corbeille.",
  "boxes.inbox.title": "Box du projet en pause après 3 plantages",
  "boxes.inbox.open": "Ouvrir le projet {name}",
  "boxes.inbox.chip": "En pause",
  "boxes.picker.scratch": "Scratch",
  "boxes.picker.scratchHint": "Un projet vide pour les sessions rapides.",
  "boxes.settings.heading": "Réglages du projet · {name}",
  "boxes.error.capacity":
    "La box n'a pas pu démarrer : le serveur est à pleine capacité. Vos fichiers sont intacts. Arrêtez une autre box ou un agent, puis réessayez.",
  "boxes.error.sandbox_unavailable":
    "La box n'a pas pu démarrer : cette machine n'a pas de microVM configurée. Vos fichiers sont intacts. Lancez `sudo pap vm setup` sur le serveur, puis réessayez.",
  "boxes.error.disk_low":
    "L'action a été refusée : le disque est presque plein. Vos fichiers sont intacts. Libérez de l'espace sur le serveur, puis réessayez.",
  "boxes.error.command_failed":
    "La box n'a pas terminé l'action. Vos fichiers sont intacts. Réessayez ; si cela échoue encore, lancez `pap doctor`.",
  "boxes.error.not_found":
    "Ce projet n'existe plus. Rien n'a été modifié. Fermez cette fenêtre et choisissez un autre projet.",
  "boxes.error.bad_request":
    "Ces réglages ne sont pas acceptés. Rien n'a été modifié. Vérifiez les valeurs indiquées, puis enregistrez à nouveau.",
  "boxes.error.read_only":
    "La base de données a été écrite par un pap plus récent et est en lecture seule. Rien n'a été modifié. Mettez pap à jour pour changer cela.",
  "boxes.error.internal":
    "Une erreur s'est produite et l'action n'a pas abouti. Vos fichiers sont intacts. Réessayez.",
  "boxes.error.conflict":
    "Le projet n'a pas été supprimé : il a changé pendant votre demande. Rien n'a été retiré. Vérifiez le projet, puis réessayez.",
  "boxes.error.conflictScratch":
    "Scratch n'a pas été supprimé : il contient encore des sessions. Rien n'a été retiré. Supprimez ou archivez ses sessions, puis réessayez.",
  "boxes.error.vm_bundle_stale":
    "La box n'a pas pu démarrer : son code est plus ancien que pap. Vos fichiers sont intacts. Lancez `sudo pap vm setup` sur le serveur, puis redémarrez la box.",
  "boxes.error.agent_paused":
    "La box a planté 3 fois en 10 minutes et est en pause. Vos fichiers sont intacts. Corrigez la cause si vous la connaissez, puis redémarrez la box.",
  "boxes.agentError.not_found":
    "Cet agent n'existe plus ou son profil est illisible, il n'y a donc pas de VM à démarrer. Rien n'a été modifié. Vérifiez Réglages › Agents.",
  "boxes.agentError.capacity":
    "La VM de l'agent n'a pas pu démarrer : le serveur est à pleine capacité. Ses fichiers sont intacts. Arrêtez une autre box ou un agent, puis réessayez.",
  "boxes.agentError.agent_paused":
    "L'agent est en pause ou en quarantaine : sa VM n'a pas été démarrée. Ses fichiers sont intacts. Reprenez-le (onglet Réglages s'il est en quarantaine, en-tête s'il est en pause), puis démarrez la VM.",
  "boxes.agentError.vm_bundle_stale":
    "La VM de l'agent n'a pas pu démarrer : son code est plus ancien que pap. Ses fichiers sont intacts. Lancez `sudo pap vm setup` sur le serveur, puis redémarrez la VM.",
  "boxes.agentError.sandbox_unavailable":
    "La VM de l'agent n'a pas pu démarrer : cette machine n'a pas de microVM configurée. Ses fichiers sont intacts. Lancez `sudo pap vm setup` sur le serveur, puis réessayez.",
  "boxes.agentError.disk_low":
    "La VM de l'agent n'a pas été démarrée : le disque est presque plein. Ses fichiers sont intacts. Libérez de l'espace sur le serveur, puis réessayez.",
  "boxes.agentError.fallback":
    "La VM de l'agent n'a pas pu démarrer. Ses fichiers sont intacts. Réessayez ; si cela échoue encore, lancez `pap doctor`.",
};
