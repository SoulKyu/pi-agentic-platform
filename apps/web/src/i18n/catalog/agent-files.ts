export const agentFilesEn = {
  "agentFiles.tab": "Files",
  "agentFiles.title": "Files in the agent's home",
  "agentFiles.hint":
    "pap keeps a copy and writes each file into the home at every VM start, and at once while the VM runs. A file the agent changed is overwritten. Content is never shown here.",
  "agentFiles.loading": "Reading the files…",
  "agentFiles.failed": "The files could not be read. Nothing was changed. Reload the tab to try again.",
  "agentFiles.col.path": "Path",
  "agentFiles.col.size": "Size",
  "agentFiles.col.date": "Imported",
  "agentFiles.empty.title": "No file yet",
  "agentFiles.empty.purpose":
    "Import a credential, such as a kubeconfig, and pap writes it into the agent's home at /agent/home.",
  "agentFiles.empty.action": "Choose file",
  "agentFiles.replace": "Replace",
  "agentFiles.replace.label": "Replace {path}",
  "agentFiles.replace.picker": "Replacement file",
  "agentFiles.remove": "Remove",
  "agentFiles.remove.label": "Remove {path}",
  "agentFiles.remove.ask":
    "Remove {path} from the agent's home? pap deletes its copy and the file leaves the VM; this cannot be undone.",
  "agentFiles.remove.confirm": "Remove file",
  "agentFiles.remove.keep": "Keep",
  "agentFiles.add.title": "Import a file",
  "agentFiles.add.path": "Path in the agent's home",
  "agentFiles.add.path.hint":
    "Relative to /agent/home, for example .kube/config. Letters, digits, . _ - and at most 8 folders.",
  "agentFiles.add.choose": "Choose file",
  "agentFiles.add.picker": "File to import",
  "agentFiles.add.chosen": "Chosen: {name}",
  "agentFiles.add.import": "Import",
  "agentFiles.error.path": "This path is not allowed: relative, no .., letters, digits, . _ - only.",
  "agentFiles.error.tooBig":
    "This file is over 1 MiB. Nothing was imported and the agent's files are unchanged. Choose a smaller file.",
  "agentFiles.error.payload_too_large":
    "This file is over 1 MiB. Nothing was imported and the agent's files are unchanged.",
  "agentFiles.error.limit_reached": "The agent already has 32 files. Nothing was imported. Remove one first.",
  "agentFiles.error.bad_request": "pap refused this path or file. Nothing was imported.",
  "agentFiles.error.failed": "The change did not go through. The agent's files are as they were. Try again.",
} as const;

export const agentFilesFr: Record<keyof typeof agentFilesEn, string> = {
  "agentFiles.tab": "Fichiers",
  "agentFiles.title": "Fichiers dans le dossier personnel de l'agent",
  "agentFiles.hint":
    "pap garde une copie et écrit chaque fichier dans le dossier à chaque démarrage de la VM, et aussitôt quand la VM tourne. Un fichier modifié par l'agent est écrasé. Le contenu n'est jamais affiché ici.",
  "agentFiles.loading": "Lecture des fichiers…",
  "agentFiles.failed":
    "Les fichiers n'ont pas pu être lus. Rien n'a été modifié. Rechargez l'onglet pour réessayer.",
  "agentFiles.col.path": "Chemin",
  "agentFiles.col.size": "Taille",
  "agentFiles.col.date": "Importé",
  "agentFiles.empty.title": "Aucun fichier",
  "agentFiles.empty.purpose":
    "Importez un identifiant, comme un kubeconfig, et pap l'écrit dans le dossier personnel de l'agent, /agent/home.",
  "agentFiles.empty.action": "Choisir un fichier",
  "agentFiles.replace": "Remplacer",
  "agentFiles.replace.label": "Remplacer {path}",
  "agentFiles.replace.picker": "Fichier de remplacement",
  "agentFiles.remove": "Retirer",
  "agentFiles.remove.label": "Retirer {path}",
  "agentFiles.remove.ask":
    "Retirer {path} du dossier personnel de l'agent ? pap supprime sa copie et le fichier quitte la VM ; c'est irréversible.",
  "agentFiles.remove.confirm": "Retirer le fichier",
  "agentFiles.remove.keep": "Garder",
  "agentFiles.add.title": "Importer un fichier",
  "agentFiles.add.path": "Chemin dans le dossier de l'agent",
  "agentFiles.add.path.hint":
    "Relatif à /agent/home, par exemple .kube/config. Lettres, chiffres, . _ - et 8 dossiers au plus.",
  "agentFiles.add.choose": "Choisir un fichier",
  "agentFiles.add.picker": "Fichier à importer",
  "agentFiles.add.chosen": "Choisi : {name}",
  "agentFiles.add.import": "Importer",
  "agentFiles.error.path":
    "Ce chemin n'est pas permis : relatif, sans .., lettres, chiffres, . _ - seulement.",
  "agentFiles.error.tooBig":
    "Ce fichier dépasse 1 Mio. Rien n'a été importé et les fichiers de l'agent sont inchangés. Choisissez un fichier plus petit.",
  "agentFiles.error.payload_too_large":
    "Ce fichier dépasse 1 Mio. Rien n'a été importé et les fichiers de l'agent sont inchangés.",
  "agentFiles.error.limit_reached":
    "L'agent a déjà 32 fichiers. Rien n'a été importé. Retirez-en un d'abord.",
  "agentFiles.error.bad_request": "pap a refusé ce chemin ou ce fichier. Rien n'a été importé.",
  "agentFiles.error.failed":
    "Le changement n'a pas abouti. Les fichiers de l'agent sont comme avant. Réessayez.",
};
