export const sidebarEn = {
  "sidebar.age.now": "now",
  "sidebar.age.min": "{n} min",
  "sidebar.age.hour": "{n} h",
  "sidebar.age.day": "{n} d",
  "sidebar.age.week": "{n} wk",
} as const;

export const sidebarFr: { readonly [K in keyof typeof sidebarEn]: string } = {
  "sidebar.age.now": "maintenant",
  "sidebar.age.min": "{n} min",
  "sidebar.age.hour": "{n} h",
  "sidebar.age.day": "{n} j",
  "sidebar.age.week": "{n} sem.",
};
