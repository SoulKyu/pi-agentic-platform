export const healthEn = {
  "health.title": "Health",
  "health.column.when": "When",
  "health.column.severity": "Severity",
  "health.column.kind": "Kind",
  "health.column.code": "Code",
  "health.column.detail": "Detail",
  "health.column.source": "Source",
  "health.column.count": "Count",
  "health.filter.label": "Filter",
  "health.filter.all": "All",
  "health.filter.feed": "Feed",
  "health.filter.sched": "Schedule",
  "health.filter.task": "Tasks",
  "health.filter.outbox": "Outbox",
  "health.filter.agent": "Agents",
  "health.severity.err": "Err",
  "health.severity.att": "Att",
  "health.severity.mut": "Mut",
  "health.search.label": "Search code or source",
  "health.more": "Load more",
  "health.retry": "Retry",
  "health.failed": "The failure list did not load. The daemon keeps running and the events are kept. Retry.",
  "health.empty.title": "No daemon failures recorded for this daemon run.",
  "health.empty.purpose": "The list follows the current daemon run and starts empty after a restart.",
  "health.empty.action": "Open the tasks board",
  "health.count": "×{n}",
  "health.kind.feed": "Feed",
  "health.kind.sched": "Schedule",
  "health.kind.task": "Task",
  "health.kind.outbox": "Outbox",
  "health.kind.agent": "Agent",
  "health.announce": "New failure: {code}",
  "health.code.feed_address":
    "The feed did not load: its address is not valid. The trigger is intact. Check its URL.",
  "health.code.feed_redirects":
    "The feed did not load: too many redirects. The trigger is intact. Check its URL.",
  "health.code.feed_too_large":
    "The feed did not load: it is too large. The trigger is intact. Check its source.",
  "health.code.feed_timeout": "The feed did not answer in time. The trigger is intact. Check its source.",
  "health.code.feed_tls": "The feed's TLS connection failed. The trigger is intact. Check its certificate.",
  "health.code.feed_network": "The feed could not be reached. The trigger is intact. Check the network.",
  "health.code.not_a_feed": "The feed did not load: not a feed. The trigger is intact. Check its URL.",
  "health.code.feed_status": "The feed answered {status}. The trigger is intact. Check the source.",
  "health.code.scheduler_failed":
    "A scheduler pass failed. The triggers are intact; the next pass runs on its own.",
  "health.code.missed":
    "A scheduled fire was missed while pap was down or busy. The trigger is intact; its next fire is still planned.",
  "health.code.precheck_failed":
    "The precheck refused the launch, so nothing ran. The trigger is intact. Check the precheck's command.",
  "health.code.task_failed":
    "A task failed. The other tasks and the board are intact. Open the task to see why.",
  "health.code.task_budget":
    "A task was stopped: it reached its budget. The work already done is kept. Raise the budget or narrow the task.",
  "health.code.task_deadline": "A task was stopped: its deadline passed.",
  "health.code.task_abort_failed":
    "A task was asked to stop but its worker did not answer. The daemon keeps trying to release it.",
  "health.code.task_release_failed":
    "A task's tools could not be released. The daemon keeps trying; nothing else is affected.",
  "health.code.task_end_failed":
    "A finished task could not be recorded. Its session is kept; the board may lag behind it.",
  "health.code.task_orphan_session":
    "A task's session was left without a task to own it. The session is kept and can be resumed by hand.",
  "health.code.outbox_handler_error":
    "An internal handler failed. The daemon keeps running and will try the step again.",
  "health.code.outbox_handler_overdue":
    "An internal handler ran past its deadline. The step finished; the daemon keeps running.",
  "health.code.outbox_unknown_kinds": "An internal step had no handler; it was skipped and noted.",
  "health.code.vm_bundle_stale":
    "An agent's VM runs older code than pap. The agent keeps working. Run the VM setup again after an update.",
  "health.code.sandbox_unavailable":
    "An agent could not start: no sandbox is available on this host. The rest of pap keeps working.",
  "health.code.agent_paused": "An agent's launches are paused. Resume it from its page when you are ready.",
  "health.code.capacity":
    "A launch was refused: the host is at its limits. Nothing is lost; try again once it frees up.",
  "health.code.agent_crash_paused": "An agent crashed three times in ten minutes; its launches are paused.",
} as const;

export const healthFr = {
  "health.title": "Santé",
  "health.column.when": "Quand",
  "health.column.severity": "Gravité",
  "health.column.kind": "Type",
  "health.column.code": "Code",
  "health.column.detail": "Détail",
  "health.column.source": "Source",
  "health.column.count": "Nombre",
  "health.filter.label": "Filtre",
  "health.filter.all": "Tous",
  "health.filter.feed": "Flux",
  "health.filter.sched": "Planif.",
  "health.filter.task": "Tâches",
  "health.filter.outbox": "Outbox",
  "health.filter.agent": "Agents",
  "health.severity.err": "Err",
  "health.severity.att": "Att",
  "health.severity.mut": "Mut",
  "health.search.label": "Rechercher un code ou une source",
  "health.more": "En charger plus",
  "health.retry": "Réessayer",
  "health.failed":
    "La liste des échecs n'a pas chargé. Le daemon continue de tourner et les événements sont conservés. Réessayez.",
  "health.empty.title": "Aucun échec enregistré pour cette exécution du daemon.",
  "health.empty.purpose": "La liste suit l'exécution actuelle du daemon et repart vide après un redémarrage.",
  "health.empty.action": "Ouvrir le tableau des tâches",
  "health.count": "×{n}",
  "health.kind.feed": "Flux",
  "health.kind.sched": "Planif.",
  "health.kind.task": "Tâche",
  "health.kind.outbox": "Outbox",
  "health.kind.agent": "Agent",
  "health.announce": "Nouvel échec : {code}",
  "health.code.feed_address":
    "Le flux n'a pas chargé : son adresse n'est pas valide. Le déclencheur est intact. Vérifiez son URL.",
  "health.code.feed_redirects":
    "Le flux n'a pas chargé : trop de redirections. Le déclencheur est intact. Vérifiez son URL.",
  "health.code.feed_too_large":
    "Le flux n'a pas chargé : il est trop volumineux. Le déclencheur est intact. Vérifiez sa source.",
  "health.code.feed_timeout":
    "Le flux n'a pas répondu à temps. Le déclencheur est intact. Vérifiez sa source.",
  "health.code.feed_tls":
    "La connexion TLS du flux a échoué. Le déclencheur est intact. Vérifiez son certificat.",
  "health.code.feed_network": "Le flux est injoignable. Le déclencheur est intact. Vérifiez le réseau.",
  "health.code.not_a_feed":
    "Le flux n'a pas chargé : ce n'est pas un flux. Le déclencheur est intact. Vérifiez son URL.",
  "health.code.feed_status": "Le flux a répondu {status}. Le déclencheur est intact. Vérifiez la source.",
  "health.code.scheduler_failed":
    "Une passe du planificateur a échoué. Les déclencheurs sont intacts ; la passe suivante s'exécute d'elle-même.",
  "health.code.missed":
    "Un tir planifié a été manqué pendant que pap était arrêté ou occupé. Le déclencheur est intact ; son prochain tir reste prévu.",
  "health.code.precheck_failed":
    "La prévérification a refusé le lancement, rien n'a tourné. Le déclencheur est intact. Vérifiez la commande de la prévérification.",
  "health.code.task_failed":
    "Une tâche a échoué. Les autres tâches et le tableau sont intacts. Ouvrez la tâche pour voir pourquoi.",
  "health.code.task_budget":
    "Une tâche a été arrêtée : elle a atteint son budget. Le travail déjà fait est conservé. Augmentez le budget ou réduisez la tâche.",
  "health.code.task_deadline": "Une tâche a été arrêtée : son échéance est passée.",
  "health.code.task_abort_failed":
    "Une tâche a reçu un arrêt mais son worker n'a pas répondu. Le daemon continue d'essayer de le libérer.",
  "health.code.task_release_failed":
    "Les outils d'une tâche n'ont pas pu être libérés. Le daemon continue d'essayer ; rien d'autre n'est affecté.",
  "health.code.task_end_failed":
    "Une tâche terminée n'a pas pu être enregistrée. Sa session est conservée ; le tableau peut être en retard sur elle.",
  "health.code.task_orphan_session":
    "La session d'une tâche s'est retrouvée sans tâche pour la porter. La session est conservée et peut être reprise à la main.",
  "health.code.outbox_handler_error":
    "Un gestionnaire interne a échoué. Le daemon continue de tourner et retentera l'étape.",
  "health.code.outbox_handler_overdue":
    "Un gestionnaire interne a dépassé son échéance. L'étape s'est terminée ; le daemon continue de tourner.",
  "health.code.outbox_unknown_kinds":
    "Une étape interne n'avait pas de gestionnaire ; elle a été ignorée et notée.",
  "health.code.vm_bundle_stale":
    "La VM d'un agent exécute un code plus ancien que pap. L'agent continue de fonctionner. Relancez la configuration des VM après une mise à jour.",
  "health.code.sandbox_unavailable":
    "Un agent n'a pas pu démarrer : aucun bac à sable n'est disponible sur cette machine. Le reste de pap continue de fonctionner.",
  "health.code.agent_paused":
    "Les lancements d'un agent sont en pause. Reprenez-le depuis sa page quand vous êtes prêt.",
  "health.code.capacity":
    "Un lancement a été refusé : la machine est à ses limites. Rien n'est perdu ; réessayez quand elle se libère.",
  "health.code.agent_crash_paused":
    "Un agent a planté trois fois en dix minutes ; ses lancements sont en pause.",
} as const;
