/** The New project dialog (decision 85, boxes lot B1): registered by its own chunk, never in the initial bundle. */
export const addProjectEn = {
  "addProject.title": "New project",
  "addProject.name": "Project name",
  "addProject.nameHint": "Its files live in its own box, not on this machine.",
  "addProject.create": "Create",
  "addProject.cancel": "Cancel",
  "addProject.nameEmpty": "Write a name for the project.",
  "addProject.error.bad_request": "This name is not accepted. Nothing was created. Write another one.",
  "addProject.error.capacity": "This account has 2000 projects, the most pap keeps.",
  "addProject.error.read_only": "The database was written by a newer pap and is read-only.",
} as const;

export const addProjectFr: { readonly [K in keyof typeof addProjectEn]: string } = {
  "addProject.title": "Nouveau projet",
  "addProject.name": "Nom du projet",
  "addProject.nameHint": "Ses fichiers vivent dans sa propre box, pas sur cette machine.",
  "addProject.create": "Créer",
  "addProject.cancel": "Annuler",
  "addProject.nameEmpty": "Écrivez un nom pour le projet.",
  "addProject.error.bad_request": "Ce nom n'est pas accepté. Rien n'a été créé. Écrivez-en un autre.",
  "addProject.error.capacity": "Ce compte a 2000 projets, le plus que pap garde.",
  "addProject.error.read_only":
    "La base de données a été écrite par un pap plus récent et est en lecture seule.",
};
