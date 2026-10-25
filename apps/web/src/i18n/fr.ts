import type { en } from "./en.ts";
import { commandsFr } from "./catalog/commands.ts";
import { devFr } from "./catalog/dev.ts";
import { launchFr } from "./catalog/launch.ts";
import { shellFr } from "./catalog/shell.ts";

const dev = (import.meta.env.DEV ? devFr : {}) as typeof devFr;

export const fr: { readonly [K in keyof typeof en]: string } = {
  ...shellFr,
  ...commandsFr,
  ...launchFr,
  ...dev,
  "app.name": "pap",
  "app.tagline": "pi agentic platform",
  "app.loading": "Chargement…",
  "gate.retry": "Réessayer",
  "setup.title": "Créer le compte propriétaire",
  "setup.username": "Nom d'utilisateur",
  "setup.password": "Mot de passe",
  "setup.usernameHint": "Lettres, chiffres, point, tiret et tiret bas ; 64 au plus.",
  "setup.passwordHint": "Au moins 12 caractères.",
  "setup.submit": "Créer le compte",
  "setup.missingToken": "Ouvrez le lien d'installation affiché dans le journal du serveur.",
  "login.title": "Connexion",
  "login.submit": "Se connecter",
  "login.passkey": "Se connecter avec une clé d'accès",
  "login.throttleNote":
    "Chaque échec double l'attente avant l'essai suivant, de 1 seconde jusqu'à 1 minute, par adresse et par compte. Un navigateur déjà connecté auparavant a sa propre limite. Elle repart de zéro après 5 minutes sans échec.",
  "login.failed": "Nom d'utilisateur ou mot de passe incorrect.",
  "login.throttled": "Trop de tentatives. Attendez {seconds} s.",
  "account.addPasskey": "Ajouter une clé d'accès",
  "account.passkeyPasswordHint": "Saisissez votre mot de passe pour ajouter une clé d'accès.",
  "account.passkeyAdded": "Clé d'accès ajoutée.",
  "account.cancel": "Annuler",
  "session.composer": "Message à envoyer",
  "session.failure": "Erreur du modèle",
  "session.omitted": "Message trop volumineux pour être affiché ({size} Ko).",
  "session.status.cold": "Arrêtée",
  "session.status.starting": "Démarrage",
  "session.status.idle": "Prête",
  "session.status.running": "En cours",
  "author.you": "Vous",
  "author.agent": "Agent IA",
  "author.tool": "Outil",
  "connection.outdated": "Une nouvelle version de pap est disponible. Rechargez la page.",
  "connection.silent": "Le daemon ne répond plus.",
  "connection.retryIn": "Nouvelle tentative dans {seconds} s",
  "connection.retry": "Réessayer",
  "connection.reconnecting": "Reconnexion…",
  "error.bad_request":
    "pap a refusé cette demande : une valeur manque ou sort des limites. Rien n'a été modifié. Vérifiez les champs et réessayez.",
  "error.unauthenticated": "Connectez-vous d'abord.",
  "error.forbidden": "Vous n'avez pas la permission pour cette action.",
  "error.not_found":
    "Cet élément n'existe plus : il a été supprimé, ou le lien est faux. Rien d'autre n'a été modifié. Choisissez-le à nouveau dans sa liste.",
  "error.conflict":
    "Cet élément a changé entre-temps, ou il existe déjà. Votre version n'a pas été enregistrée. Rechargez, puis refaites votre modification.",
  "error.rate_limited": "Trop de tentatives. Réessayez plus tard.",
  "error.payload_too_large": "Le message est trop volumineux.",
  "error.capacity":
    "pap est à pleine capacité : tous les emplacements de worker sont pris. Rien n'a été lancé. Réessayez quand une session se termine, ou arrêtez-en une.",
  "error.capacityWorkers": "{used} / {max} workers actifs.",
  "error.worker_failed":
    "Le processus de la session s'est arrêté. La transcription est intacte. Renvoyez votre message pour le relancer.",
  "error.timeout":
    "La session n'a pas répondu à temps. L'action a peut-être abouti : vérifiez avant de réessayer.",
  "error.prompt_rejected":
    "La session n'a pas pu lancer cette demande. Vérifiez le modèle et le fournisseur.",
  "error.invalid_cwd": "Le dossier de travail doit être le chemin absolu d'un dossier existant.",
  "error.step_up_required": "Confirmez votre mot de passe pour continuer.",
  "error.read_only":
    "Un pap plus récent a écrit cette base de données : celui-ci l'a ouverte en lecture seule. Rien n'a été modifié. Mettez pap à jour pour l'utiliser à nouveau.",
  "error.unknown_method": "Cette version de la page ne correspond pas au serveur. Rechargez-la.",
  "error.internal":
    "pap a rencontré une erreur inattendue. L'action n'a peut-être pas abouti : vérifiez son résultat, puis réessayez. Si elle se répète, lancez pap doctor.",
  "error.connection_lost":
    "La connexion a été coupée avant la réponse. L'action a peut-être abouti : vérifiez avant de réessayer.",
  "error.offline":
    "pap est injoignable : cette page n'atteint pas le daemon. Vos brouillons restent sur cet appareil. Vérifiez que pap tourne, puis réessayez.",
  "error.passkey_cancelled": "La demande de clé d'accès a été annulée.",
  "error.passkey_failed":
    "La clé d'accès n'a pas pu être utilisée. Réessayez, ou utilisez votre mot de passe.",
  "error.password_incorrect": "Mot de passe incorrect.",
  "error.queue_full": "Trop de messages attendent dans cette session. Attendez l'agent, ou videz la file.",
  "error.session_busy": "La session travaille. Attendez qu'elle finisse, ou arrêtez-la d'abord.",
  "error.session_empty": "Cette session n'a encore aucun message à traiter.",
  "error.command_failed": "La session n'a pas pu exécuter cette commande.",
  "session.status.releasing": "Libération",
  // ── session screen in the shell (P3) ──
  "sessions.announce.runEnded": "L'agent a terminé.",
  "sessions.announce.approval": "L'agent attend votre approbation.",
  "sessions.transcript.thought": "Réflexion terminée",
  "sessions.code.copy": "Copier le code",
  "sessions.code.copied": "Copié",
  "sessions.transcript.label": "Échanges",
  "session.status.needsInput": "Attend votre réponse",
  "row.actions": "Actions du message",
  "branch.group": "Branche {index} sur {total}",
  "connection.draftsStay": "Vos brouillons restent sur cet appareil.",
};
