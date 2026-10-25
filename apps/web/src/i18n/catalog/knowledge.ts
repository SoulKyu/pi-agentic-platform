/** OKF knowledge: the session chip and the project page row (sub-project 5), registered by `register-knowledge.ts`. */
export const knowledgeEn = {
  "knowledge.chip.on": "OKF",
  "knowledge.chip.off": "No OKF",
  "knowledge.chip.enable": "Enable OKF for this project",
  "knowledge.chip.pending": "OKF enabled; it applies from this session's next start",
  "knowledge.row.absent": "Agents in this project keep their knowledge as markdown files in {folder}.",
  "knowledge.row.present": "OKF knowledge in {folder} · {count} concepts",
  "knowledge.row.enable": "Enable OKF",
  "knowledge.row.lane": "In this lane's worktree",
  "knowledge.row.refused":
    'OKF was not enabled: knowledge/ is a link or a file, or its index.md has no okf_version. Nothing was written. Rename it, or add okf_version: "0.2" to its index.md, then try again.',
  "knowledge.row.unwritable":
    "OKF was not enabled: the folder cannot be written or no longer exists. Nothing was written. Check that it exists and that pap may write in it, then try again.",
} as const;

export const knowledgeFr: { readonly [K in keyof typeof knowledgeEn]: string } = {
  "knowledge.chip.on": "OKF",
  "knowledge.chip.off": "Sans OKF",
  "knowledge.chip.enable": "Activer OKF pour ce projet",
  "knowledge.chip.pending": "OKF activé ; il s'applique au prochain démarrage de cette session",
  "knowledge.row.absent":
    "Les agents de ce projet gardent leurs connaissances en fichiers markdown dans {folder}.",
  "knowledge.row.present": "Connaissances OKF dans {folder} · {count} concepts",
  "knowledge.row.enable": "Activer OKF",
  "knowledge.row.lane": "Dans le worktree de cette lane",
  "knowledge.row.refused":
    "OKF n'a pas été activé : knowledge/ est un lien ou un fichier, ou son index.md n'a pas d'okf_version. Rien n'a été écrit. Renommez-le, ou ajoutez okf_version: \"0.2\" à son index.md, puis réessayez.",
  "knowledge.row.unwritable":
    "OKF n'a pas été activé : le dossier n'est pas accessible en écriture ou n'existe plus. Rien n'a été écrit. Vérifiez qu'il existe et que pap peut y écrire, puis réessayez.",
};
