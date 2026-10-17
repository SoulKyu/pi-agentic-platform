// Texts the daemon writes in English into stored rows (T12), shown in the viewer's language by `i18n/pap-text.ts`.
export const papTextEn = {
  "papText.reminderTitle": "Reminder",
  "papText.reminderNotDelivered": "Reminder not delivered: the thread it was set in was reset",
};

export const papTextFr: Record<keyof typeof papTextEn, string> = {
  "papText.reminderTitle": "Rappel",
  "papText.reminderNotDelivered": "Rappel non remis : le fil où il a été créé a été réinitialisé",
};
