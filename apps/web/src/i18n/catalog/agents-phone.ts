export const agentsPhoneEn = {
  "agentsPhone.emptyTitle": "Create your first agent",
  "agentsPhone.emptyPurpose": "A long-term agent has its own thread, memory, budget and triggers.",
  "agentsPhone.noVmTitle": "Agents are unavailable",
  "agentsPhone.noVmPurpose":
    "Agents run in microVMs: this machine needs KVM and `sudo pap vm setup`. See `pap doctor`.",
};

export const agentsPhoneFr: { readonly [K in keyof typeof agentsPhoneEn]: string } = {
  "agentsPhone.emptyTitle": "Créez votre premier agent",
  "agentsPhone.emptyPurpose":
    "Un agent de long terme a son propre fil, sa mémoire, son budget et ses déclencheurs.",
  "agentsPhone.noVmTitle": "Les agents sont indisponibles",
  "agentsPhone.noVmPurpose":
    "Les agents tournent dans des microVM : cette machine a besoin de KVM et de `sudo pap vm setup`. Voir `pap doctor`.",
};
