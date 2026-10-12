export const settingsApprovalsEn = {
  "approvals.intro": "What the agent may do without asking you, and what it may never do.",
} as const;
export const settingsApprovalsFr: { readonly [K in keyof typeof settingsApprovalsEn]: string } = {
  "approvals.intro": "Ce que l'agent peut faire sans vous demander, et ce qu'il ne peut jamais faire.",
};
