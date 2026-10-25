import { describe, expect, it } from "vitest";
import { launchProgressEn, launchProgressFr } from "./catalog/launch-progress.ts";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import { getLocale, t } from "./index.ts";
import "./register-launch.ts";

const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

const EXACT: ReadonlyArray<readonly [string, string, string]> = [
  ["launch.step.checks", "Checks", "Vérifications"],
  ["launch.step.image", "Project image", "Image du projet"],
  ["launch.step.imageAgent", "Agent image", "Image de l'agent"],
  ["launch.step.disk", "Disk", "Disque"],
  ["launch.step.vm", "VM start", "Démarrage de la VM"],
  ["launch.step.guest", "Guest ready", "Invité prêt"],
  ["launch.step.worker", "Session ready", "Session prête"],
  ["launch.title.project", "Starting the box", "Démarrage de la box"],
  ["launch.title.agent", "Starting the agent", "Démarrage de l'agent"],
  ["launch.title.build", "Building the image", "Construction de l'image"],
  ["launch.time.skipped", "already built", "déjà construite"],
  ["launch.time.usual", "{elapsed} · usually {usual}", "{elapsed} · d'habitude {usual}"],
  [
    "launch.slow",
    "Slower than usual. pap gives up at {limit}.",
    "Plus lent que d'habitude. pap abandonne à {limit}.",
  ],
  ["launch.sign", "{line} · {ago} ago", "{line} · il y a {ago}"],
  [
    "launch.ask",
    "No news from {step} for {ago}. pap gives up at {limit}.",
    "Aucune nouvelle de {step} depuis {ago}. pap abandonne à {limit}.",
  ],
  [
    "launch.ask.long",
    "{step} has been running for {elapsed}. pap gives up at {limit}.",
    "{step} tourne depuis {elapsed}. pap abandonne à {limit}.",
  ],
  ["launch.ask.log", "Show the log", "Voir le journal"],
  ["launch.ask.stop", "Stop", "Arrêter"],
  [
    "launch.wait.session_slots",
    "Waiting for a session slot · {used}/{max} in use",
    "En attente d'une place de session · {used}/{max} prises",
  ],
  ["launch.wait.session_slots.action", "See the sessions", "Voir les sessions"],
  ["launch.wait.box_memory", "Box memory full · {used} / {max}", "Mémoire des box pleine · {used} / {max}"],
  [
    "launch.wait.box_memory.action",
    "Stop a box to start this one.",
    "Arrêtez une box pour démarrer celle-ci.",
  ],
  [
    "launch.wait.image_build",
    "Waiting for another image build · {position} in line",
    "En attente d'une autre construction d'image · {position} dans la file",
  ],
  [
    "launch.wait.pi_reads",
    "Waiting for Pi · {waiting} reads ahead",
    "En attente de Pi · {waiting} lectures avant",
  ],
  ["launch.wait.budget", "Daily budget reached", "Budget du jour atteint"],
  ["launch.wait.paused", "Paused after repeated crashes", "En pause après des plantages répétés"],
  ["launch.wait.paused.action", "Restart the box", "Redémarrer la box"],
  ["launch.wait.relay", "Waiting for pap's relay", "En attente du relais de pap"],
  [
    "launch.wait.thread_busy",
    "Waiting for the agent's thread to finish",
    "En attente de la fin du fil de l'agent",
  ],
  ["launch.wait.next", "Next try in {seconds}", "Prochain essai dans {seconds}"],
  ["launch.activity", "{count} in progress", "{count} en cours"],
  ["launch.lane", "Preparing the worktree", "Préparation du worktree"],
  ["launch.stage.checks", "Checking…", "Vérifications…"],
  ["launch.stage.image", "Building the image…", "Construction de l'image…"],
  ["launch.stage.disk", "Preparing the disk…", "Préparation du disque…"],
  ["launch.stage.vm", "Starting the VM…", "Démarrage de la VM…"],
  ["launch.stage.guest", "Waiting for the guest…", "Attente de l'invité…"],
  ["launch.stage.worker", "Starting the session…", "Démarrage de la session…"],
  ["loading.cause.pi", "Pi is reading {active} things at once", "Pi lit {active} choses à la fois"],
  ["loading.cause.piWaiting", "{waiting} reads waiting", "{waiting} lectures en attente"],
  ["loading.cause.box", "The box answers slowly", "La box répond lentement"],
  ["launch.wait.session_slots.short", "Waiting for a session slot", "En attente d'une place de session"],
  [
    "launch.wait.image_build.short",
    "Waiting for another image build",
    "En attente d'une autre construction d'image",
  ],
  ["launch.wait.box_memory.short", "Box memory full", "Mémoire des box pleine"],
  ["launch.wait.pi_reads.short", "Waiting for Pi", "En attente de Pi"],
  ["launch.log.empty", "Nothing to show yet.", "Rien à afficher pour l'instant."],
  ["launch.log.loading", "Reading the log…", "Lecture du journal…"],
  ["launch.steps.show", "Show the steps", "Voir les étapes"],
  ["launch.steps.hide", "Hide the steps", "Masquer les étapes"],
];

describe("lazy catalog (launch progress)", () => {
  it("every launch key has EN and FR, with the same slots, none empty", () => {
    expect(Object.keys(launchProgressFr)).toEqual(Object.keys(launchProgressEn));
    for (const key of Object.keys(launchProgressEn) as Array<keyof typeof launchProgressEn>) {
      expect(launchProgressFr[key], key).not.toBe("");
      expect(slots(launchProgressFr[key]), key).toEqual(slots(launchProgressEn[key]));
    }
    const keys = Object.keys(launchProgressEn);
    expect(keys.filter((key) => key.startsWith("launch.step.")).length).toBe(7);
    expect(keys.filter((key) => key.startsWith("loading.cause.")).length).toBe(3);
  });

  it("carries the exact sentences of the brief", () => {
    expect(launchProgressEn["launch.ask"]).toBe("No news from {step} for {ago}. pap gives up at {limit}.");
    expect(launchProgressFr["launch.ask"]).toBe(
      "Aucune nouvelle de {step} depuis {ago}. pap abandonne à {limit}.",
    );
    expect(launchProgressEn["launch.wait.pi_reads"]).toBe("Waiting for Pi · {waiting} reads ahead");
    expect(launchProgressFr["launch.stage.worker"]).toBe("Démarrage de la session…");
  });

  it("registers its keys when a chunk imports register-launch.ts", () => {
    expect(getLocale()).toBe("en");
    expect(t("launch.wait.next", { seconds: "8 s" })).toBe("Next try in 8 s");
  });

  it.each(EXACT)("%s has its exact EN and FR text", (key, english, french) => {
    expect((launchProgressEn as Record<string, string>)[key]).toBe(english);
    expect((launchProgressFr as Record<string, string>)[key]).toBe(french);
  });

  it("covers every key in the table", () => {
    expect(EXACT.map(([key]) => key)).toEqual(Object.keys(launchProgressEn));
  });

  it("stays out of the eager catalogs", () => {
    for (const key of Object.keys(launchProgressEn)) {
      expect(Object.hasOwn(en, key), key).toBe(false);
      expect(Object.hasOwn(fr, key), key).toBe(false);
    }
  });

  it("puts error.pi_busy in the eager catalogs, without a count (PapError carries none)", () => {
    expect((en as Record<string, string>)["error.pi_busy"]).toBe(
      "Pi is busy: too many reads are waiting. Nothing was read. Try again in a moment.",
    );
    expect((fr as Record<string, string>)["error.pi_busy"]).toBe(
      "Pi est occupé : trop de lectures attendent. Rien n'a été lu. Réessayez dans un instant.",
    );
  });
});
