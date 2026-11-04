export const agentsPhoneEn = {
  "agentsPhone.noVmTitle": "Agents are unavailable",
  "agentsPhone.noVmPurpose":
    "Agents run in microVMs: this machine needs KVM and `sudo pap vm setup`. See `pap doctor`.",
};

export const agentsPhoneFr: { readonly [K in keyof typeof agentsPhoneEn]: string } = {
  "agentsPhone.noVmTitle": "Les agents sont indisponibles",
  "agentsPhone.noVmPurpose":
    "Les agents tournent dans des microVM : cette machine a besoin de KVM et de `sudo pap vm setup`. Voir `pap doctor`.",
};
