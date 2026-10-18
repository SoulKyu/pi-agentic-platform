// The model picker (models batch, MPR6): the search box, the list's states, its two footnotes and the models read from
// extensions on a click (ADR 0070 as amended). Registered by `i18n/register-model-picker.ts`, with the chunk that
// renders the list.
export const modelPickerEn = {
  "modelPicker.search": "Search models",
  "modelPicker.list": "Models",
  "modelPicker.close": "Close",
  "modelPicker.loading": "Loading models",
  "modelPicker.failed": "The models could not be loaded.",
  "modelPicker.retry": "Try again",
  "modelPicker.noMatch": "No model matches",
  "modelPicker.empty": "No model available. Connect a provider in settings.",
  "modelPicker.settings": "Open settings",
  "modelPicker.truncated": "The list is cut short: narrow your search.",
  "modelPicker.notOffered": "Saved model, no longer offered",
  "modelPicker.savedExtension": "May come from an extension, checked when it runs",
  "modelPicker.footnote.extensions": "Models added by an extension are listed only when you ask for them.",
  "modelPicker.footnote.command": "A key that is a command is offered but may fail when used.",
  "modelPicker.reload": "Reload the page: pap was updated.",
  "modelPicker.choose": "Choose a model",
  "modelPicker.showMore": "Show {count} more",
  "modelPicker.extensions.show": "Show models added by extensions",
  "modelPicker.extensions.note":
    "Reading them runs your global extensions; an extension may use the network on its own.",
  "modelPicker.extensions.reading": "Reading the extensions",
  "modelPicker.extensions.again": "Read again",
  "modelPicker.extensions.mark": "from an extension",
  "modelPicker.extensions.count.one": "1 model added by an extension is listed.",
  "modelPicker.extensions.count.other": "{count} models added by extensions are listed.",
  "modelPicker.extensions.empty": "No extension adds a model.",
  "modelPicker.extensions.failed": "An extension did not load, so no model of an extension is listed.",
  "modelPicker.extensions.truncated":
    "Some providers added by extensions are not shown: the list is cut short.",
  "modelPicker.extensions.modelsTruncated": "Some models of this provider are not shown.",
  "modelPicker.extensions.unoffered.one":
    "1 model added by an extension is not offered: it is outside your model selection, or its provider has no key.",
  "modelPicker.extensions.unoffered.other":
    "{count} models added by extensions are not offered: outside your model selection, or their provider has no key.",
  "modelPicker.extensions.forbidden": "Models added by extensions need the Pi administration permission.",
  "modelPicker.extensions.settings": "Choose them in Settings › Models › Available models",
  "modelPicker.extensions.refreshFailed":
    "They could not be read again ({reason}): what is listed may be out of date.",
  "modelPicker.extensions.noneHere":
    "Chat only loads no extension: a model an extension adds is refused for this agent.",
  "modelPicker.notOfferedHint":
    "Not offered now: a run uses Pi's default model instead. Settings › Models › Available models decides what is offered.",
  "modelPicker.notOfferedChatHint":
    "Not offered in Chat only, which loads no extension: a run uses another model instead. Choose a model Pi has, or another tool preset.",
};

export const modelPickerFr: Record<keyof typeof modelPickerEn, string> = {
  "modelPicker.search": "Rechercher un modèle",
  "modelPicker.list": "Modèles",
  "modelPicker.close": "Fermer",
  "modelPicker.loading": "Chargement des modèles",
  "modelPicker.failed": "Les modèles n'ont pas pu être chargés.",
  "modelPicker.retry": "Réessayer",
  "modelPicker.noMatch": "Aucun modèle ne correspond",
  "modelPicker.empty": "Aucun modèle disponible. Connectez un fournisseur dans les réglages.",
  "modelPicker.settings": "Ouvrir les réglages",
  "modelPicker.truncated": "La liste est tronquée : affinez votre recherche.",
  "modelPicker.notOffered": "Modèle enregistré, plus proposé",
  "modelPicker.savedExtension": "Peut venir d'une extension, vérifié à l'exécution",
  "modelPicker.footnote.extensions":
    "Les modèles ajoutés par une extension ne sont listés que si vous le demandez.",
  "modelPicker.footnote.command": "Une clé qui est une commande est proposée mais peut échouer à l'usage.",
  "modelPicker.reload": "Rechargez la page : pap a été mis à jour.",
  "modelPicker.choose": "Choisir un modèle",
  "modelPicker.showMore": "Afficher {count} de plus",
  "modelPicker.extensions.show": "Afficher les modèles ajoutés par des extensions",
  "modelPicker.extensions.note":
    "Leur lecture exécute vos extensions globales ; une extension peut utiliser le réseau de son propre chef.",
  "modelPicker.extensions.reading": "Lecture des extensions",
  "modelPicker.extensions.again": "Relire",
  "modelPicker.extensions.mark": "d'une extension",
  "modelPicker.extensions.count.one": "1 modèle ajouté par une extension est listé.",
  "modelPicker.extensions.count.other": "{count} modèles ajoutés par des extensions sont listés.",
  "modelPicker.extensions.empty": "Aucune extension n'ajoute de modèle.",
  "modelPicker.extensions.failed":
    "Une extension ne s'est pas chargée : aucun modèle d'extension n'est listé.",
  "modelPicker.extensions.truncated":
    "Certains fournisseurs ajoutés par des extensions ne sont pas affichés : la liste est tronquée.",
  "modelPicker.extensions.modelsTruncated": "Certains modèles de ce fournisseur ne sont pas affichés.",
  "modelPicker.extensions.unoffered.one":
    "1 modèle ajouté par une extension n'est pas proposé : il est hors de votre sélection de modèles, ou son fournisseur n'a pas de clé.",
  "modelPicker.extensions.unoffered.other":
    "{count} modèles ajoutés par des extensions ne sont pas proposés : hors de votre sélection de modèles, ou leur fournisseur n'a pas de clé.",
  "modelPicker.extensions.forbidden":
    "Les modèles ajoutés par des extensions demandent la permission d'administration de Pi.",
  "modelPicker.extensions.settings": "Les choisir dans Réglages › Modèles › Modèles proposés",
  "modelPicker.extensions.refreshFailed":
    "Ils n'ont pas pu être relus ({reason}) : ce qui est listé peut ne plus être à jour.",
  "modelPicker.extensions.noneHere":
    "Chat seul ne charge aucune extension : un modèle ajouté par une extension est refusé pour cet agent.",
  "modelPicker.notOfferedHint":
    "Pas proposé pour l'instant : une exécution utilise alors le modèle par défaut de Pi. Réglages › Modèles › Modèles proposés décide de ce qui est proposé.",
  "modelPicker.notOfferedChatHint":
    "Pas proposé en Chat seul, qui ne charge aucune extension : une exécution utilise alors un autre modèle. Choisissez un modèle de Pi, ou un autre préréglage d'outils.",
};
