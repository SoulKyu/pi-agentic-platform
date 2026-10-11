export const galleryEn = {
  "gallery.title": "UI gallery",
} as const;

export const galleryFr: { readonly [K in keyof typeof galleryEn]: string } = {
  "gallery.title": "Galerie de l'interface",
};
