/** Rich replies (UX-2): the images of the box, math, diagrams and HTML previews in a reply. Registered by `register-rich-replies.ts`. */
export const richRepliesEn = {
  "reply.rich.image": "[image: {alt}]",
  "reply.rich.openFile": "Open {path} in Files",
  "reply.rich.preview": "Preview",
  "reply.rich.hide": "Hide",
  "reply.rich.artifactFrame": "UNTRUSTED · html from the reply",
  "reply.rich.artifactTitle": "HTML preview",
  "reply.rich.mermaidError": "This diagram could not be drawn.",
  "reply.rich.mermaidTooLarge": "This diagram is too large to draw here.",
  "reply.rich.diagram": "Diagram",
};

export const richRepliesFr: Record<keyof typeof richRepliesEn, string> = {
  "reply.rich.image": "[image : {alt}]",
  "reply.rich.openFile": "Ouvrir {path} dans Fichiers",
  "reply.rich.preview": "Aperçu",
  "reply.rich.hide": "Masquer",
  "reply.rich.artifactFrame": "NON FIABLE · html de la réponse",
  "reply.rich.artifactTitle": "Aperçu HTML",
  "reply.rich.mermaidError": "Ce diagramme n'a pas pu être dessiné.",
  "reply.rich.mermaidTooLarge": "Ce diagramme est trop grand pour être dessiné ici.",
  "reply.rich.diagram": "Diagramme",
};
