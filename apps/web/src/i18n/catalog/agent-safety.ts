// The agent's Settings tab: permissions sheet, secrets list, quarantine, delete (M11R126). Lazy: registered by
// `features/agents/register-space-catalog.ts`.
export const agentSafetyEn = {
  "agentSafety.tab.label": "Agent view",
  "agentSafety.tab.thread": "Thread",
  "agentSafety.tab.settings": "Settings",
  "agentSafety.actions.title": "Thread and safety",
  "agentSafety.actions.reset": "Reset thread",
  "agentSafety.actions.resetHint": "Archives the thread and starts a fresh one. Memory and files stay.",
  "agentSafety.actions.quarantine": "Quarantine…",
  "agentSafety.actions.quarantineHint":
    "Stops everything this agent does at once and rotates what it could leak. Resuming asks for your password.",
  "agentSafety.actions.delete": "Delete…",
  "agentSafety.actions.deleteHint": "Moves its home to .trash and deletes its triggers and secrets.",

  "agentSafety.perm.title": "Permissions",
  "agentSafety.perm.loading": "Reading the permissions…",
  "agentSafety.perm.failed": "The permissions could not be read.",
  "agentSafety.perm.intro":
    "What this agent can do, from its settings and, once its thread runs, from the tools that thread loaded.",
  "agentSafety.perm.note":
    "A running thread keeps the sandbox and network settings it started with until its run ends.",
  "agentSafety.perm.tools": "Tools: preset {preset}.",
  "agentSafety.perm.tools.active": "Active tools: {tools}.",
  "agentSafety.perm.tools.unknown":
    "Active tools: listed once its thread has started (pap starts nothing just to show this).",
  "agentSafety.perm.sandbox.on": "Sandbox: on. Its shell runs in bubblewrap, with its own folders.",
  "agentSafety.perm.sandbox.off": "Sandbox: off. Its shell runs as you, with your files and your network.",
  "agentSafety.perm.sandbox.unavailable":
    "Sandbox: required but not available on this machine, so it cannot start a shell.",
  "agentSafety.perm.network.on": "Network: allowed.",
  "agentSafety.perm.network.off": "Network: off.",
  "agentSafety.perm.egress.proxied":
    "Egress: proxied. Its shell's traffic goes through pap's allowlist proxy.",
  "agentSafety.perm.egress.off":
    "Egress: off. pap's proxy is not in the path (the network is off, or the sandbox is not on).",
  "agentSafety.perm.hosts": "Hosts: {hosts}",
  "agentSafety.perm.hosts.owner": "Hosts: the list you set for all agents",
  "agentSafety.perm.hosts.any":
    "Hosts: none for its shell (no list is set); its URL tools may reach any host",
  "agentSafety.perm.hosts.none": "Hosts: none (its URL tools reach no host)",
  "agentSafety.perm.blocked": "Blocked commands: {n} rules (yours and this agent's).",
  "agentSafety.perm.vault": "Secrets in its vault: {names}.",
  "agentSafety.perm.vault.none": "Secrets in its vault: none.",
  "agentSafety.perm.triggers": "Triggers that wake it",
  "agentSafety.perm.triggers.none": "No trigger wakes it.",
  "agentSafety.perm.trigger": "{name} · {source} → {target}",
  "agentSafety.perm.source.schedule": "schedule",
  "agentSafety.perm.source.webhook": "webhook",
  "agentSafety.perm.source.feed": "feed",
  "agentSafety.perm.source.manual": "manual",
  "agentSafety.perm.target.thread": "its thread",
  "agentSafety.perm.target.isolated": "an isolated task",
  "agentSafety.perm.mcp":
    "MCP servers: the ones you set up in Settings › MCP. pap cannot tell here which of them a thread uses.",
  "agentSafety.perm.sources": "Trusted sources: {hosts}.",
  "agentSafety.perm.sources.none": "Trusted sources: none.",
  "agentSafety.perm.autonomy.on":
    "Trusted autonomy: on. After external content it no longer gets the extra questions for its shell's network, agent_remind and agent_delegate. A booby-trapped page can then make it send its folder or vault to a host it can reach.",
  "agentSafety.perm.autonomy.off":
    "Trusted autonomy: off. After external content it still gets those extra questions.",
  "agentSafety.tri.title": "Lethal trifecta: {n} of 3",
  "agentSafety.tri.none":
    "Advice only, nothing is blocked: the three legs together are what a booby-trapped page needs.",
  "agentSafety.tri.all.can":
    "3 of 3: this agent can read private data, read untrusted content and send data out. That is the combination a booby-trapped page needs; this is advice, nothing is blocked.",
  "agentSafety.tri.all.may":
    "3 of 3: this agent may read private data, read untrusted content and send data out. That is the combination a booby-trapped page needs; this is advice, nothing is blocked.",
  "agentSafety.tri.private.can":
    "This agent can read private data: its file tools reach your files because the sandbox is not on.",
  "agentSafety.tri.private.may":
    "This agent may read private data: its file tools reach your files unless the sandbox is on.",
  "agentSafety.tri.private.none":
    "This agent cannot read private data: it has no file tools, or the sandbox keeps them to its own folders.",
  "agentSafety.tri.untrusted.can":
    "This agent can read untrusted content: a web tool, an MCP server, or a webhook or feed trigger.",
  "agentSafety.tri.untrusted.may":
    "This agent may read untrusted content: a web tool, an MCP server, or a webhook or feed trigger.",
  "agentSafety.tri.untrusted.none": "This agent reads no untrusted content that pap knows of.",
  "agentSafety.tri.exfil.can":
    "This agent can send data out: through a web tool, an MCP server, or a networked shell to any host the proxy lets it reach.",
  "agentSafety.tri.exfil.may":
    "This agent may send data out: through a web tool, an MCP server, or a networked shell to any host the proxy lets it reach.",
  "agentSafety.tri.exfil.open.can":
    "This agent can send data out: its shell is unrestricted (the sandbox is not on), so it can reach any host you can.",
  "agentSafety.tri.exfil.open.may":
    "This agent may send data out: its shell is unrestricted unless the sandbox is on, and then it can reach any host you can.",
  "agentSafety.tri.exfil.unavailable.can":
    "This agent can send data out: through a web tool or an MCP server (its shell cannot start: the sandbox it requires is unavailable).",
  "agentSafety.tri.exfil.unavailable.may":
    "This agent may send data out: through a web tool or an MCP server (its shell cannot start: the sandbox it requires is unavailable).",
  "agentSafety.tri.exfil.noshell.can":
    "This agent can send data out: through a web tool or an MCP server (its shell has no network).",
  "agentSafety.tri.exfil.noshell.may":
    "This agent may send data out: through a web tool or an MCP server (its shell has no network).",
  "agentSafety.tri.exfil.none":
    "This agent cannot send data out: no networked shell, web tool or MCP server.",
  "agentSafety.tri.remove": "To remove a leg",
  "agentSafety.tri.remove.private": "Private data: keep the sandbox on, or give it no file tools.",
  "agentSafety.tri.remove.untrusted":
    "Untrusted content: remove its webhook and feed triggers, and the MCP servers and web tools it does not need.",
  "agentSafety.tri.remove.exfil":
    "Sending data out: turn the sandbox network off, or give it its own short host list instead of any host the proxy lets it reach.",
  "agentSafety.tri.remove.exfil.unavailable":
    "Sending data out: remove its web tools and MCP servers (its shell cannot start while the sandbox is unavailable).",
  "agentSafety.tri.remove.exfil.open":
    "Sending data out: turn the sandbox on, then turn its network off or give it its own short host list. Without the sandbox, its shell reaches any host you can.",

  "agentSafety.secrets.title": "Secrets",
  "agentSafety.secrets.intro":
    "Values are never shown again. The agent's shell gets them as environment variables; outputs show [SECRET:NAME]. Without the sandbox, the vault is not given to the shell.",
  "agentSafety.secrets.limits":
    "Encrypted in pap's vault: at most 50 names, up to 4 096 characters per value.",
  "agentSafety.secrets.protects":
    "Encryption protects against: a copy of a vault file without its key file, and an agent reading pap's files through its tools.",
  "agentSafety.secrets.notAgainst.process":
    "Not against: a process of yours that can read both the vault and its key file.",
  "agentSafety.secrets.notAgainst.backup":
    "Not against: a backup of the whole $PAP_HOME. The key sits beside the vault, so such a backup is as good as plaintext unless it leaves the key out.",
  "agentSafety.secrets.loading": "Reading the secrets…",
  "agentSafety.secrets.failed": "The secrets could not be read.",
  "agentSafety.secrets.empty": "No secret saved yet.",
  "agentSafety.secrets.unreadable":
    "The vault cannot be read: its file or its key cannot be opened. Nothing is listed until it is restored.",
  "agentSafety.secrets.saved": "saved {date}",
  "agentSafety.secrets.name": "Name",
  "agentSafety.secrets.name.hint": "Capital letters, digits and _, like GITHUB_TOKEN",
  "agentSafety.secrets.name.invalid":
    "Use capital letters, digits and _, starting with a letter, like GITHUB_TOKEN.",
  "agentSafety.secrets.value": "Value",
  "agentSafety.secrets.add": "Add secret",
  "agentSafety.secrets.delete": "Delete",
  "agentSafety.secrets.delete.label": "Delete {name}",
  "agentSafety.secrets.delete.ask":
    "Delete {name} from this agent's vault? Its next thread or task no longer gets it.",
  "agentSafety.secrets.keep": "Keep",

  "agentSafety.q.title": "Quarantine {name}?",
  "agentSafety.q.intro": "This is the incident button. pap will:",
  "agentSafety.q.step.pause": "pause the agent",
  "agentSafety.q.step.tasks": "cancel its running and queued tasks",
  "agentSafety.q.step.thread": "close its thread and its open requests, and drop its one-use secret values",
  "agentSafety.q.step.rotate": "rotate its webhook secrets and show you the new ones once",
  "agentSafety.q.step.vault": "list its vault entries, which you rotate where they were issued",
  "agentSafety.q.second":
    "{name} stops now and stays stopped until you resume it with your password. Nothing it already did is undone.",
  "agentSafety.q.continue": "Continue",
  "agentSafety.q.cancel": "Cancel",
  "agentSafety.q.confirm": "Quarantine {name}",
  "agentSafety.q.done": "Done",
  "agentSafety.q.doneTitle": "{name} is quarantined",
  "agentSafety.q.secrets": "New webhook secrets",
  "agentSafety.q.secrets.note": "Shown once. pap cannot show these again: copy them now where you need them.",
  "agentSafety.q.copy": "Copy",
  "agentSafety.q.copy.label": "Copy secret of {name}",
  "agentSafety.q.copied": "Copied.",
  "agentSafety.q.copyFailed": "The clipboard refused; select the value and copy it by hand.",
  "agentSafety.q.vault": "Rotate these where they were issued: {names}.",
  "agentSafety.q.tasks": "Tasks cancelled: {n}",
  "agentSafety.q.errors": "These steps did not finish. The other steps ran:",
  "agentSafety.q.error": "{step}: {reason}",
  "agentSafety.q.errorStep.tasks": "Cancelling tasks",
  "agentSafety.q.errorStep.subagents": "Stopping subagents",
  "agentSafety.q.errorStep.thread": "Closing the thread",
  "agentSafety.q.errorStep.requests": "Closing requests",
  "agentSafety.q.errorStep.once_values": "Dropping one-use values",
  "agentSafety.q.errorStep.triggers": "Rotating webhook secrets",
  "agentSafety.q.errorStep.vault": "Listing vault names",
  "agentSafety.q.errorStep.memory": "Setting staged memories aside",
  "agentSafety.q.errorStep.vm": "Stopping the agent's VM",
  "agentSafety.q.reason.timeout": "did not finish in time",
  "agentSafety.q.reason.failed": "failed",
  "agentSafety.q.unreadable":
    "The quarantine ran, but its answer could not be read: check the agent's state.",
  "agentSafety.q.replay":
    "This quarantine already ran. Its new webhook secrets were shown once and cannot be shown again; rotate them from each trigger if you missed them.",

  "agentSafety.d.title": "Delete {name}?",
  "agentSafety.d.body":
    "The home and its tasks' scratch folders go to .trash, its triggers and secrets are deleted. This asks for your password.",
  "agentSafety.d.confirm": "Delete {name}",
  "agentSafety.d.cancel": "Cancel",
  "agentSafety.d.done": "{name} deleted. Its home is in .trash.",
  "agentSafety.d.partial":
    "The home was moved to .trash but a later step failed. {name} stays quarantined; delete it again to finish.",

  "agentSafety.actions.resume": "Resume from quarantine",
  "agentSafety.actions.resumeHint": "Clears the quarantine and lets it run again. Asks for your password.",
  "agentSafety.resume.conflict":
    "This agent's deletion did not finish, so it cannot be resumed. Delete it again to finish.",
  "agentSafety.resume.busy": "A quarantine is still running for this agent. Try again in a moment.",
};

export const agentSafetyFr: { readonly [K in keyof typeof agentSafetyEn]: string } = {
  "agentSafety.tab.label": "Vue de l'agent",
  "agentSafety.tab.thread": "Fil",
  "agentSafety.tab.settings": "Réglages",
  "agentSafety.actions.title": "Fil et sécurité",
  "agentSafety.actions.reset": "Réinitialiser le fil",
  "agentSafety.actions.resetHint":
    "Archive le fil et en commence un nouveau. La mémoire et les fichiers restent.",
  "agentSafety.actions.quarantine": "Mettre en quarantaine…",
  "agentSafety.actions.quarantineHint":
    "Arrête d'un coup tout ce que fait cet agent et fait tourner ce qu'il pourrait divulguer. Le reprendre demande votre mot de passe.",
  "agentSafety.actions.delete": "Supprimer…",
  "agentSafety.actions.deleteHint":
    "Déplace son dossier personnel dans .trash et supprime ses déclencheurs et ses secrets.",

  "agentSafety.perm.title": "Permissions",
  "agentSafety.perm.loading": "Lecture des permissions…",
  "agentSafety.perm.failed": "Les permissions n'ont pas pu être lues.",
  "agentSafety.perm.intro":
    "Ce que cet agent peut faire, d'après ses réglages et, une fois son fil lancé, d'après les outils que ce fil a chargés.",
  "agentSafety.perm.note":
    "Un fil en cours garde le bac à sable et le réseau avec lesquels il a démarré jusqu'à la fin de son exécution.",
  "agentSafety.perm.tools": "Outils : préréglage {preset}.",
  "agentSafety.perm.tools.active": "Outils actifs : {tools}.",
  "agentSafety.perm.tools.unknown":
    "Outils actifs : listés une fois son fil démarré (pap ne démarre rien juste pour l'afficher).",
  "agentSafety.perm.sandbox.on":
    "Bac à sable : activé. Son shell tourne dans bubblewrap, avec ses propres dossiers.",
  "agentSafety.perm.sandbox.off":
    "Bac à sable : désactivé. Son shell tourne comme vous, avec vos fichiers et votre réseau.",
  "agentSafety.perm.sandbox.unavailable":
    "Bac à sable : exigé mais indisponible sur cette machine, donc il ne peut pas lancer de shell.",
  "agentSafety.perm.network.on": "Réseau : autorisé.",
  "agentSafety.perm.network.off": "Réseau : coupé.",
  "agentSafety.perm.egress.proxied":
    "Sortie : via proxy. Le trafic de son shell passe par le proxy à liste d'autorisation de pap.",
  "agentSafety.perm.egress.off":
    "Sortie : coupée. Le proxy de pap n'est pas sur le chemin (le réseau est coupé, ou le bac à sable n'est pas activé).",
  "agentSafety.perm.hosts": "Hôtes : {hosts}",
  "agentSafety.perm.hosts.owner": "Hôtes : la liste que vous avez fixée pour tous les agents",
  "agentSafety.perm.hosts.any":
    "Hôtes : aucun pour son shell (aucune liste n'est fixée) ; ses outils d'URL peuvent atteindre n'importe quel hôte",
  "agentSafety.perm.hosts.none": "Hôtes : aucun (ses outils d'URL n'atteignent aucun hôte)",
  "agentSafety.perm.blocked": "Commandes bloquées : {n} règles (les vôtres et celles de cet agent).",
  "agentSafety.perm.vault": "Secrets dans son coffre : {names}.",
  "agentSafety.perm.vault.none": "Secrets dans son coffre : aucun.",
  "agentSafety.perm.triggers": "Déclencheurs qui le réveillent",
  "agentSafety.perm.triggers.none": "Aucun déclencheur ne le réveille.",
  "agentSafety.perm.trigger": "{name} · {source} → {target}",
  "agentSafety.perm.source.schedule": "planification",
  "agentSafety.perm.source.webhook": "webhook",
  "agentSafety.perm.source.feed": "flux",
  "agentSafety.perm.source.manual": "manuel",
  "agentSafety.perm.target.thread": "son fil",
  "agentSafety.perm.target.isolated": "une tâche isolée",
  "agentSafety.perm.mcp":
    "Serveurs MCP : ceux que vous avez configurés dans Réglages › MCP. pap ne peut pas dire ici lesquels un fil utilise.",
  "agentSafety.perm.sources": "Sources de confiance : {hosts}.",
  "agentSafety.perm.sources.none": "Sources de confiance : aucune.",
  "agentSafety.perm.autonomy.on":
    "Autonomie de confiance : activée. Après du contenu externe, il ne reçoit plus les questions en plus pour le réseau de son shell, agent_remind et agent_delegate. Une page piégée peut alors lui faire envoyer son dossier ou son coffre à un hôte qu'il atteint.",
  "agentSafety.perm.autonomy.off":
    "Autonomie de confiance : désactivée. Après du contenu externe, il reçoit toujours ces questions en plus.",
  "agentSafety.tri.title": "Triade létale : {n} sur 3",
  "agentSafety.tri.none":
    "Simple conseil, rien n'est bloqué : les trois branches réunies sont ce qu'il faut à une page piégée.",
  "agentSafety.tri.all.can":
    "3 sur 3 : cet agent peut lire des données privées, lire du contenu non fiable et envoyer des données à l'extérieur. C'est la combinaison qu'il faut à une page piégée ; c'est un conseil, rien n'est bloqué.",
  "agentSafety.tri.all.may":
    "3 sur 3 : cet agent peut éventuellement lire des données privées, lire du contenu non fiable et envoyer des données à l'extérieur. C'est la combinaison qu'il faut à une page piégée ; c'est un conseil, rien n'est bloqué.",
  "agentSafety.tri.private.can":
    "Cet agent peut lire des données privées : ses outils de fichiers atteignent vos fichiers car le bac à sable n'est pas activé.",
  "agentSafety.tri.private.may":
    "Cet agent peut éventuellement lire des données privées : ses outils de fichiers atteignent vos fichiers sauf si le bac à sable est activé.",
  "agentSafety.tri.private.none":
    "Cet agent ne peut pas lire de données privées : il n'a pas d'outils de fichiers, ou le bac à sable les limite à ses dossiers.",
  "agentSafety.tri.untrusted.can":
    "Cet agent peut lire du contenu non fiable : un outil web, un serveur MCP, ou un déclencheur webhook ou flux.",
  "agentSafety.tri.untrusted.may":
    "Cet agent peut éventuellement lire du contenu non fiable : un outil web, un serveur MCP, ou un déclencheur webhook ou flux.",
  "agentSafety.tri.untrusted.none": "Cet agent ne lit aucun contenu non fiable que pap connaisse.",
  "agentSafety.tri.exfil.can":
    "Cet agent peut envoyer des données à l'extérieur : par un outil web, un serveur MCP, ou un shell en réseau vers n'importe quel hôte que le proxy le laisse atteindre.",
  "agentSafety.tri.exfil.may":
    "Cet agent peut éventuellement envoyer des données à l'extérieur : par un outil web, un serveur MCP, ou un shell en réseau vers n'importe quel hôte que le proxy le laisse atteindre.",
  "agentSafety.tri.exfil.open.can":
    "Cet agent peut envoyer des données à l'extérieur : son shell n'est pas restreint (le bac à sable n'est pas activé), il atteint donc tous les hôtes que vous atteignez.",
  "agentSafety.tri.exfil.open.may":
    "Cet agent peut éventuellement envoyer des données à l'extérieur : son shell n'est pas restreint tant que le bac à sable n'est pas activé, et il atteint alors tous les hôtes que vous atteignez.",
  "agentSafety.tri.exfil.unavailable.can":
    "Cet agent peut envoyer des données à l'extérieur : par un outil web ou un serveur MCP (son shell ne peut pas démarrer : le bac à sable qu'il exige est indisponible).",
  "agentSafety.tri.exfil.unavailable.may":
    "Cet agent peut éventuellement envoyer des données à l'extérieur : par un outil web ou un serveur MCP (son shell ne peut pas démarrer : le bac à sable qu'il exige est indisponible).",
  "agentSafety.tri.exfil.noshell.can":
    "Cet agent peut envoyer des données à l'extérieur : par un outil web ou un serveur MCP (son shell n'a pas de réseau).",
  "agentSafety.tri.exfil.noshell.may":
    "Cet agent peut éventuellement envoyer des données à l'extérieur : par un outil web ou un serveur MCP (son shell n'a pas de réseau).",
  "agentSafety.tri.exfil.none":
    "Cet agent ne peut pas envoyer de données à l'extérieur : ni shell en réseau, ni outil web, ni serveur MCP.",
  "agentSafety.tri.remove": "Pour retirer une branche",
  "agentSafety.tri.remove.private":
    "Données privées : gardez le bac à sable activé, ou ne lui donnez aucun outil de fichiers.",
  "agentSafety.tri.remove.untrusted":
    "Contenu non fiable : retirez ses déclencheurs webhook et flux, et les serveurs MCP et outils web dont il n'a pas besoin.",
  "agentSafety.tri.remove.exfil":
    "Envoi de données : coupez le réseau du bac à sable, ou donnez-lui sa propre courte liste d'hôtes au lieu de n'importe quel hôte que le proxy le laisse atteindre.",
  "agentSafety.tri.remove.exfil.unavailable":
    "Envoi de données : retirez ses outils web et ses serveurs MCP (son shell ne peut pas démarrer tant que le bac à sable est indisponible).",
  "agentSafety.tri.remove.exfil.open":
    "Envoi de données : activez le bac à sable, puis coupez son réseau ou donnez-lui sa propre courte liste d'hôtes. Sans le bac à sable, son shell atteint tous les hôtes que vous atteignez.",

  "agentSafety.secrets.title": "Secrets",
  "agentSafety.secrets.intro":
    "Les valeurs ne sont plus jamais affichées. Le shell de l'agent les reçoit comme variables d'environnement ; les sorties affichent [SECRET:NOM]. Sans le bac à sable, le coffre n'est pas donné au shell.",
  "agentSafety.secrets.limits":
    "Chiffrés dans le coffre de pap : 50 noms au plus, 4 096 caractères au plus par valeur.",
  "agentSafety.secrets.protects":
    "Le chiffrement protège contre : la copie d'un fichier du coffre sans son fichier de clé, et un agent qui lit les fichiers de pap avec ses outils.",
  "agentSafety.secrets.notAgainst.process":
    "Pas contre : un de vos processus qui peut lire à la fois le coffre et son fichier de clé.",
  "agentSafety.secrets.notAgainst.backup":
    "Pas contre : une sauvegarde de tout $PAP_HOME. La clé est à côté du coffre, donc une telle sauvegarde vaut du texte en clair, sauf si elle laisse la clé de côté.",
  "agentSafety.secrets.loading": "Lecture des secrets…",
  "agentSafety.secrets.failed": "Les secrets n'ont pas pu être lus.",
  "agentSafety.secrets.empty": "Aucun secret enregistré pour l'instant.",
  "agentSafety.secrets.unreadable":
    "Le coffre est illisible : son fichier ou sa clé ne s'ouvre pas. Rien n'est listé tant qu'il n'est pas restauré.",
  "agentSafety.secrets.saved": "enregistré le {date}",
  "agentSafety.secrets.name": "Nom",
  "agentSafety.secrets.name.hint": "Majuscules, chiffres et _, comme GITHUB_TOKEN",
  "agentSafety.secrets.name.invalid":
    "Utilisez des majuscules, des chiffres et _, en commençant par une lettre, comme GITHUB_TOKEN.",
  "agentSafety.secrets.value": "Valeur",
  "agentSafety.secrets.add": "Ajouter le secret",
  "agentSafety.secrets.delete": "Supprimer",
  "agentSafety.secrets.delete.label": "Supprimer {name}",
  "agentSafety.secrets.delete.ask":
    "Supprimer {name} du coffre de cet agent ? Son prochain fil ou sa prochaine tâche ne l'aura plus.",
  "agentSafety.secrets.keep": "Garder",

  "agentSafety.q.title": "Mettre {name} en quarantaine ?",
  "agentSafety.q.intro": "C'est le bouton d'incident. pap va :",
  "agentSafety.q.step.pause": "mettre l'agent en pause",
  "agentSafety.q.step.tasks": "annuler ses tâches en cours et en file",
  "agentSafety.q.step.thread":
    "fermer son fil et ses requêtes ouvertes, et jeter ses valeurs secrètes à usage unique",
  "agentSafety.q.step.rotate":
    "renouveler ses secrets de webhook et vous montrer les nouveaux une seule fois",
  "agentSafety.q.step.vault":
    "lister les entrées de son coffre, que vous renouvelez là où elles ont été émises",
  "agentSafety.q.second":
    "{name} s'arrête maintenant et reste arrêté jusqu'à ce que vous le repreniez avec votre mot de passe. Rien de ce qu'il a déjà fait n'est annulé.",
  "agentSafety.q.continue": "Continuer",
  "agentSafety.q.cancel": "Annuler",
  "agentSafety.q.confirm": "Mettre {name} en quarantaine",
  "agentSafety.q.done": "Terminé",
  "agentSafety.q.doneTitle": "{name} est en quarantaine",
  "agentSafety.q.secrets": "Nouveaux secrets de webhook",
  "agentSafety.q.secrets.note":
    "Affichés une seule fois. pap ne pourra plus les montrer : copiez-les maintenant là où il le faut.",
  "agentSafety.q.copy": "Copier",
  "agentSafety.q.copy.label": "Copier le secret de {name}",
  "agentSafety.q.copied": "Copié.",
  "agentSafety.q.copyFailed": "Le presse-papiers a refusé ; sélectionnez la valeur et copiez-la à la main.",
  "agentSafety.q.vault": "À renouveler là où ils ont été émis : {names}.",
  "agentSafety.q.tasks": "Tâches annulées : {n}",
  "agentSafety.q.errors": "Ces étapes ne se sont pas terminées. Les autres étapes ont tourné :",
  "agentSafety.q.error": "{step} : {reason}",
  "agentSafety.q.errorStep.tasks": "Annulation des tâches",
  "agentSafety.q.errorStep.subagents": "Arrêt des sous-agents",
  "agentSafety.q.errorStep.thread": "Fermeture du fil",
  "agentSafety.q.errorStep.requests": "Fermeture des requêtes",
  "agentSafety.q.errorStep.once_values": "Abandon des valeurs à usage unique",
  "agentSafety.q.errorStep.triggers": "Renouvellement des secrets de webhook",
  "agentSafety.q.errorStep.vault": "Liste des noms du coffre",
  "agentSafety.q.errorStep.memory": "Mise de côté des souvenirs en attente",
  "agentSafety.q.errorStep.vm": "Arrêt de la VM de l'agent",
  "agentSafety.q.reason.timeout": "ne s'est pas terminée à temps",
  "agentSafety.q.reason.failed": "a échoué",
  "agentSafety.q.unreadable":
    "La quarantaine a eu lieu, mais sa réponse n'a pas pu être lue : vérifiez l'état de l'agent.",
  "agentSafety.q.replay":
    "Cette quarantaine a déjà eu lieu. Ses nouveaux secrets de webhook ont été montrés une seule fois et ne peuvent plus l'être ; renouvelez-les depuis chaque déclencheur si vous les avez manqués.",

  "agentSafety.d.title": "Supprimer {name} ?",
  "agentSafety.d.body":
    "Son dossier personnel et les dossiers temporaires de ses tâches vont dans .trash, ses déclencheurs et ses secrets sont supprimés. Votre mot de passe est demandé.",
  "agentSafety.d.confirm": "Supprimer {name}",
  "agentSafety.d.cancel": "Annuler",
  "agentSafety.d.done": "{name} est supprimé. Son dossier personnel est dans .trash.",
  "agentSafety.d.partial":
    "Le dossier personnel a été déplacé dans .trash mais une étape suivante a échoué. {name} reste en quarantaine ; supprimez-le encore pour finir.",

  "agentSafety.actions.resume": "Reprendre après la quarantaine",
  "agentSafety.actions.resumeHint": "Lève la quarantaine et le laisse repartir. Demande votre mot de passe.",
  "agentSafety.resume.conflict":
    "La suppression de cet agent n'est pas terminée, il ne peut donc pas reprendre. Supprimez-le encore pour finir.",
  "agentSafety.resume.busy": "Une quarantaine est encore en cours pour cet agent. Réessayez dans un instant.",
};
