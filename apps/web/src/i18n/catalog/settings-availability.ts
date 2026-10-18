// Settings > Models, the availability view (models batch, MPR16, MPR17): the mode, the provider switches, the preview
// and the read-only list of the providers extensions add. Registered by `i18n/register-settings-availability.ts`, with
// the chunk that renders them.
export const settingsAvailabilityEn = {
  "settingsAvailability.title": "Available models",
  "settingsAvailability.intro": "Choose which models your pickers offer.",
  "settingsAvailability.mode.label": "Which models are offered",
  "settingsAvailability.mode.all": "All the models of the connected providers",
  "settingsAvailability.mode.selection": "My selection",
  "settingsAvailability.mode.allNote":
    "Every model of a connected provider is offered. Choose My selection to switch some off.",
  "settingsAvailability.readOnly":
    "This project's settings file, {path}, decides here. The switches are read-only.",
  "settingsAvailability.confirm.ask.one":
    "Offer all models? This deletes your saved selection ({count} entry). There is no undo.",
  "settingsAvailability.confirm.ask.other":
    "Offer all models? This deletes your saved selection ({count} entries). There is no undo.",
  "settingsAvailability.confirm.list": "Your selection today",
  "settingsAvailability.confirm.more": "and {count} more",
  "settingsAvailability.confirm.yes": "Use all models",
  "settingsAvailability.confirm.no": "Keep my selection",
  "settingsAvailability.providers": "Provider switches",
  "settingsAvailability.chip.connected": "connected",
  "settingsAvailability.chip.notConnected": "not connected",
  "settingsAvailability.count": "{offered}/{total} offered",
  "settingsAvailability.count.total.one": "{count} model",
  "settingsAvailability.count.total.other": "{count} models",
  "settingsAvailability.partial": "{on} of {total} are on",
  "settingsAvailability.expand": "Show the models of {provider}",
  "settingsAvailability.collapse": "Hide the models of {provider}",
  "settingsAvailability.notOffered": "Not offered until the provider is connected",
  "settingsAvailability.models.more": "Show {count} more",
  "settingsAvailability.models.truncated": "The list of this provider is cut short.",
  "settingsAvailability.unmatched.title": "These entries of your selection match no model:",
  "settingsAvailability.unmatched.clean": "Clean up",
  "settingsAvailability.unmatched.kept.extension":
    "An extension adds this provider: its models are matched when the extensions load, and Clean up keeps it.",
  "settingsAvailability.unmatched.kept.unjudged":
    "Kept by Clean up: it names no provider loaded here, so it may be an extension's.",
  "settingsAvailability.preview.title": "What your pickers offer",
  "settingsAvailability.preview.count.one": "{count} model",
  "settingsAvailability.preview.count.other": "{count} models",
  "settingsAvailability.preview.origin.signed-in": "Only the providers you are connected to",
  "settingsAvailability.preview.origin.scope": "Your selection, among connected providers",
  "settingsAvailability.preview.loading": "Loading the preview",
  "settingsAvailability.preview.failed": "The preview could not be loaded.",
  "settingsAvailability.preview.retry": "Try again",
  "settingsAvailability.preview.empty": "No model is offered.",
  "settingsAvailability.preview.groups.more": "Show {count} more providers",
  "settingsAvailability.preview.groups.less": "Show fewer providers",
  "settingsAvailability.preview.rows.more": "and {count} more",
  "settingsAvailability.preview.truncated": "The preview is cut short.",
  "settingsAvailability.reload": "Reload the page: pap was updated.",
  "settingsAvailability.extensions.title": "Providers added by extensions",
  "settingsAvailability.extensions.read": "Read providers added by extensions",
  "settingsAvailability.extensions.reading": "Reading the extensions",
  "settingsAvailability.extensions.note":
    "Once read, here or in a model picker, their models get switches like the others, and the agent and lane pickers offer what your selection offers. Reading them runs your global extensions, and so does a switch Pi cannot apply without them (one of their models, leaving all the models on, or an entry they may share); an extension may use the network on its own. No key or header is shown.",
  "settingsAvailability.extensions.again": "Read again",
  "settingsAvailability.extensions.refreshFailed":
    "They could not be read again ({reason}): the switches below show the last reading.",
  "settingsAvailability.extensions.notOffered":
    "Not offered to the pickers and agents: outside your selection, or its provider has no key.",
  "settingsAvailability.extensions.empty": "No extension adds a provider.",
  "settingsAvailability.extensions.noModels": "No models",
  "settingsAvailability.extensions.failed":
    "An extension did not load, so this list may be missing providers.",
  "settingsAvailability.extensions.truncated": "Some providers are not shown: the list is cut short.",
  "settingsAvailability.extensions.modelsTruncated": "Some models of this provider are not shown.",
  "settingsAvailability.extensions.overrides": "overrides",
  "settingsAvailability.extensions.overridesNote":
    "Replaces the provider of the same name in models.json: its models come from the extension.",
  "settingsAvailability.extensions.overridesUnknown":
    "The list of your providers is cut short, so a provider that replaces one of models.json may not be marked.",
};

export const settingsAvailabilityFr: Record<keyof typeof settingsAvailabilityEn, string> = {
  "settingsAvailability.title": "Modèles proposés",
  "settingsAvailability.intro": "Choisissez les modèles que proposent vos sélecteurs.",
  "settingsAvailability.mode.label": "Quels modèles sont proposés",
  "settingsAvailability.mode.all": "Tous les modèles des fournisseurs connectés",
  "settingsAvailability.mode.selection": "Ma sélection",
  "settingsAvailability.mode.allNote":
    "Tous les modèles d'un fournisseur connecté sont proposés. Choisissez Ma sélection pour en désactiver.",
  "settingsAvailability.readOnly":
    "Le fichier de réglages de ce projet, {path}, fait foi ici. Les interrupteurs sont en lecture seule.",
  "settingsAvailability.confirm.ask.one":
    "Proposer tous les modèles ? Votre sélection enregistrée ({count} entrée) sera supprimée, sans retour possible.",
  "settingsAvailability.confirm.ask.other":
    "Proposer tous les modèles ? Votre sélection enregistrée ({count} entrées) sera supprimée, sans retour possible.",
  "settingsAvailability.confirm.list": "Votre sélection actuelle",
  "settingsAvailability.confirm.more": "et {count} de plus",
  "settingsAvailability.confirm.yes": "Utiliser tous les modèles",
  "settingsAvailability.confirm.no": "Garder ma sélection",
  "settingsAvailability.providers": "Interrupteurs des fournisseurs",
  "settingsAvailability.chip.connected": "connecté",
  "settingsAvailability.chip.notConnected": "non connecté",
  "settingsAvailability.count": "{offered}/{total} proposés",
  "settingsAvailability.count.total.one": "{count} modèle",
  "settingsAvailability.count.total.other": "{count} modèles",
  "settingsAvailability.partial": "{on} sur {total} activés",
  "settingsAvailability.expand": "Afficher les modèles de {provider}",
  "settingsAvailability.collapse": "Masquer les modèles de {provider}",
  "settingsAvailability.notOffered": "Non proposé tant que le fournisseur n'est pas connecté",
  "settingsAvailability.models.more": "Afficher {count} de plus",
  "settingsAvailability.models.truncated": "La liste de ce fournisseur est tronquée.",
  "settingsAvailability.unmatched.title": "Ces entrées de votre sélection ne correspondent à aucun modèle :",
  "settingsAvailability.unmatched.clean": "Nettoyer",
  "settingsAvailability.unmatched.kept.extension":
    "Une extension ajoute ce fournisseur : ses modèles correspondent une fois les extensions chargées, et Nettoyer la garde.",
  "settingsAvailability.unmatched.kept.unjudged":
    "Gardée par Nettoyer : elle ne nomme aucun fournisseur chargé ici, elle peut donc être celle d'une extension.",
  "settingsAvailability.preview.title": "Ce que proposent vos sélecteurs",
  "settingsAvailability.preview.count.one": "{count} modèle",
  "settingsAvailability.preview.count.other": "{count} modèles",
  "settingsAvailability.preview.origin.signed-in": "Seulement les fournisseurs auxquels vous êtes connecté",
  "settingsAvailability.preview.origin.scope": "Votre sélection, parmi les fournisseurs connectés",
  "settingsAvailability.preview.loading": "Chargement de l'aperçu",
  "settingsAvailability.preview.failed": "L'aperçu n'a pas pu être chargé.",
  "settingsAvailability.preview.retry": "Réessayer",
  "settingsAvailability.preview.empty": "Aucun modèle n'est proposé.",
  "settingsAvailability.preview.groups.more": "Afficher {count} fournisseurs de plus",
  "settingsAvailability.preview.groups.less": "Afficher moins de fournisseurs",
  "settingsAvailability.preview.rows.more": "et {count} de plus",
  "settingsAvailability.preview.truncated": "L'aperçu est tronqué.",
  "settingsAvailability.reload": "Rechargez la page : pap a été mis à jour.",
  "settingsAvailability.extensions.title": "Fournisseurs ajoutés par des extensions",
  "settingsAvailability.extensions.read": "Lire les fournisseurs ajoutés par des extensions",
  "settingsAvailability.extensions.reading": "Lecture des extensions",
  "settingsAvailability.extensions.note":
    "Une fois lus, ici ou dans un sélecteur de modèle, leurs modèles ont des interrupteurs comme les autres, et les sélecteurs d'agent et de lane proposent ce que votre sélection propose. Les lire exécute vos extensions globales, comme un interrupteur que Pi ne peut pas appliquer sans elles (l'un de leurs modèles, quitter tous les modèles activés, ou une entrée qu'elles peuvent partager) ; une extension peut utiliser le réseau de son propre chef. Ni clé ni en-tête ne sont affichés.",
  "settingsAvailability.extensions.again": "Relire",
  "settingsAvailability.extensions.refreshFailed":
    "Ils n'ont pas pu être relus ({reason}) : les interrupteurs ci-dessous montrent la dernière lecture.",
  "settingsAvailability.extensions.notOffered":
    "Non proposé aux sélecteurs ni aux agents : hors de votre sélection, ou son fournisseur n'a pas de clé.",
  "settingsAvailability.extensions.empty": "Aucune extension n'ajoute de fournisseur.",
  "settingsAvailability.extensions.noModels": "Aucun modèle",
  "settingsAvailability.extensions.failed":
    "Une extension ne s'est pas chargée : il peut manquer des fournisseurs dans cette liste.",
  "settingsAvailability.extensions.truncated":
    "Certains fournisseurs ne sont pas affichés : la liste est tronquée.",
  "settingsAvailability.extensions.modelsTruncated":
    "Certains modèles de ce fournisseur ne sont pas affichés.",
  "settingsAvailability.extensions.overrides": "remplace",
  "settingsAvailability.extensions.overridesNote":
    "Remplace le fournisseur du même nom dans models.json : ses modèles viennent de l'extension.",
  "settingsAvailability.extensions.overridesUnknown":
    "La liste de vos fournisseurs est tronquée : un fournisseur qui remplace l'un de ceux de models.json peut ne pas être signalé.",
};
