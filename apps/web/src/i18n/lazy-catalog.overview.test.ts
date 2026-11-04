import { describe, expect, it } from "vitest";
import { overviewEn, overviewFr } from "./catalog/overview.ts";
import { agentsPhoneEn, agentsPhoneFr } from "./catalog/agents-phone.ts";
import { frenchSpacing } from "./fr-spacing.ts";

const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const FAMILIAR = /(?<![\p{L}'])(tu|ton|ta|tes|te|toi)(?![\p{L}])/iu;

describe("catalog (overview)", () => {
  it("has the same keys and slots in English and French", () => {
    expect(Object.keys(overviewFr)).toEqual(Object.keys(overviewEn));
    for (const key of Object.keys(overviewEn) as Array<keyof typeof overviewEn>)
      expect(slots(overviewFr[key]), key).toEqual(slots(overviewEn[key]));
  });

  it("carries the exact words of the Global Constraints", () => {
    const pairs: ReadonlyArray<readonly [keyof typeof overviewEn, string, string]> = [
      ["overview.title", "Overview", "Vue d'ensemble"],
      ["overview.band.memory", "Box memory", "Mémoire des boxes"],
      ["overview.band.workers", "Pi workers", "Workers Pi"],
      ["overview.band.cost", "Cost today · all", "Coût du jour · tous"],
      ["overview.band.membersCost", "of which members {cost}", "dont membres {cost}"],
      ["overview.band.full", "Full", "Plein"],
      ["overview.band.apiEquivalent", "API-equivalent included", "équivalent API inclus"],
      ["overview.band.shared", "Shared capacity", "Capacité partagée"],
      ["overview.band.yourBoxes", "Your boxes", "Vos boxes"],
      ["overview.band.yourCost", "Your cost today", "Votre coût du jour"],
      ["overview.band.noBudget", "no budget", "sans budget"],
      ["overview.group.you", "You", "Vous"],
      ["overview.group.members", "Members", "Membres"],
      ["overview.member.name", "{name} · member", "{name} · membre"],
      ["overview.member.boxes", "Active boxes", "Boxes actives"],
      ["overview.member.memory", "Memory", "Mémoire"],
      ["overview.member.cost", "Cost today", "Coût du jour"],
      ["overview.state.waiting", "Waiting", "Attend"],
      ["overview.state.failed", "Failed", "Échec"],
      ["overview.state.running", "Running", "Tourne"],
      ["overview.state.starting", "Starting", "Démarre"],
      ["overview.phase.stopped", "Stopped", "Arrêtée"],
      ["overview.phase.starting", "Starting", "Démarre"],
      ["overview.phase.running", "Running", "En marche"],
      ["overview.phase.paused", "Paused", "En pause"],
      ["overview.kind.agent", "Agent", "Agent"],
      ["overview.kind.project", "Project", "Projet"],
      ["overview.kind.host", "Project on this host", "Projet sur cet hôte"],
      ["overview.card.noBox", "no box", "sans box"],
      ["overview.card.since", "since {time}", "depuis {time}"],
      ["overview.card.tomorrow", "tomorrow {time}", "demain {time}"],
      ["overview.card.more", "+{count} more", "+{count} de plus"],
      ["overview.activity.thread", "Thread", "Thread"],
      ["overview.activity.session", "Session", "Session"],
      ["overview.activity.task", "Task", "Tâche"],
      ["overview.ask.agent_approve", "Approval", "Approbation"],
      ["overview.ask.task_needs_input", "Input needed", "Réponse attendue"],
      ["overview.ask.secret_request", "Secret", "Secret"],
      ["overview.ask.session", "Waiting in this session", "En attente dans cette session"],
      ["overview.answer", "Answer", "Répondre"],
      ["overview.stop", "Stop", "Arrêter"],
      ["overview.expand", "Expand", "Déplier"],
      ["overview.checkAgain", "Check again", "Vérifier à nouveau"],
      ["overview.stopped.count.one", "{count} stopped", "{count} arrêtée"],
      ["overview.stopped.count.other", "{count} stopped", "{count} arrêtées"],
      ["overview.card.next", "Next {time} · {name}", "Prochaine {time} · {name}"],
      [
        "overview.empty.idle",
        "Nothing is running. Start a box or open an agent to talk to it.",
        "Rien ne tourne. Démarrez une box ou ouvrez un agent pour lui parler.",
      ],
      [
        "overview.empty.purpose",
        "Here you will see every agent and every project: what runs, what waits for you, what it costs.",
        "Ici, vous verrez chaque agent et chaque projet : ce qui tourne, ce qui vous attend, ce que ça coûte.",
      ],
      [
        "overview.noMemory.owner",
        "Not enough memory: {need} needed, {free} free. Stop a box to start another.",
        "Pas assez de mémoire : {need} demandés, {free} libres. Arrêtez une box pour en démarrer une autre.",
      ],
      [
        "overview.noMemory.member",
        "Not enough shared memory: this box needs {need}. Stop one of your boxes or try again later.",
        "Pas assez de mémoire partagée : cette box demande {need}. Arrêtez une de vos boxes ou réessayez plus tard.",
      ],
      ["overview.stopDialog.title", "Stop {name}'s box?", "Arrêter la box de {name} ?"],
      [
        "overview.stopDialog.body",
        "What runs in it will be interrupted: {list}. Transcripts and the box's files are intact; tasks can be retried.",
        "Ce qui y tourne sera interrompu : {list}. Les transcriptions et les fichiers de la box sont intacts ; les tâches peuvent être relancées.",
      ],
      ["overview.alwaysOn", "Always on", "Toujours allumée"],
      [
        "overview.stopDialog.alwaysOn",
        "It stays always on: pap starts it again when pap next starts.",
        "Elle reste toujours allumée : pap la rallumera à son prochain démarrage.",
      ],
      ["overview.stopDialog.cancel", "Cancel", "Annuler"],
      ["overview.stopDialog.confirm", "Stop the box", "Arrêter la box"],
      ["overview.health.one", "{count} recent failure", "{count} échec récent"],
      ["overview.health.other", "{count} recent failures", "{count} échecs récents"],
    ];
    for (const [key, en, fr] of pairs) {
      expect(overviewEn[key], key).toBe(en);
      expect(overviewFr[key], key).toBe(fr);
    }
  });

  it("has no dead keys", () => {
    for (const key of ["overview.open", "overview.start"]) {
      expect(overviewEn).not.toHaveProperty(key);
      expect(overviewFr).not.toHaveProperty(key);
    }
  });

  it("percentages and sizes keep the locale's own form", () => {
    expect(overviewEn["overview.percent"]).toBe("{value}%");
    expect(overviewFr["overview.percent"]).toBe("{value} %");
    expect(frenchSpacing(overviewFr["overview.percent"])).toBe("{value} %");
    expect(overviewEn["overview.size"]).toBe("{value} GB");
    expect(overviewFr["overview.size"]).toBe("{value} Go");
  });

  it("copies the agents catalog's NoVmState sentence", () => {
    expect(overviewEn["overview.noVm.title"]).toBe(agentsPhoneEn["agentsPhone.noVmTitle"]);
    expect(overviewEn["overview.noVm.purpose"]).toBe(agentsPhoneEn["agentsPhone.noVmPurpose"]);
    expect(overviewFr["overview.noVm.title"]).toBe(agentsPhoneFr["agentsPhone.noVmTitle"]);
    expect(overviewFr["overview.noVm.purpose"]).toBe(agentsPhoneFr["agentsPhone.noVmPurpose"]);
  });

  it("speaks to the owner with vous", () => {
    for (const text of Object.values(overviewFr)) expect(text).not.toMatch(FAMILIAR);
  });
});
