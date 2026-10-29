import { describe, expect, it } from "vitest";
import { lanesEn, lanesFr } from "./catalog/lanes.ts";
import { shellEn, shellFr } from "./catalog/shell.ts";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import { errorKey } from "./index.ts";

const EXPECTED: Record<string, readonly [string, string]> = {
  "error.bad_request": [
    "pap refused this request: a value is missing or out of range. Nothing was changed. Check the fields and try again.",
    "pap a refusé cette demande : une valeur manque ou sort des limites. Rien n'a été modifié. Vérifiez les champs et réessayez.",
  ],
  "error.not_found": [
    "This item no longer exists: it was deleted, or the link is wrong. Nothing else was changed. Pick it again from its list.",
    "Cet élément n'existe plus : il a été supprimé, ou le lien est faux. Rien d'autre n'a été modifié. Choisissez-le à nouveau dans sa liste.",
  ],
  "error.conflict": [
    "This changed in the meantime, or it already exists. Your version was not saved. Reload, then make your change again.",
    "Cet élément a changé entre-temps, ou il existe déjà. Votre version n'a pas été enregistrée. Rechargez, puis refaites votre modification.",
  ],
  "error.capacity": [
    "pap is at capacity: every worker slot is in use. Nothing was started. Try again when a session finishes, or stop one.",
    "pap est à pleine capacité : tous les emplacements de worker sont pris. Rien n'a été lancé. Réessayez quand une session se termine, ou arrêtez-en une.",
  ],
  "error.worker_failed": [
    "The session process stopped. The transcript is intact. Send again to restart it.",
    "Le processus de la session s'est arrêté. La transcription est intacte. Renvoyez votre message pour le relancer.",
  ],
  "error.read_only": [
    "A newer pap wrote this database, so this one opened it read-only. Nothing was changed. Update pap to use it again.",
    "Un pap plus récent a écrit cette base de données : celui-ci l'a ouverte en lecture seule. Rien n'a été modifié. Mettez pap à jour pour l'utiliser à nouveau.",
  ],
  "error.internal": [
    "pap hit an unexpected error. The action may not have completed: check its result, then try again. If it repeats, run pap doctor.",
    "pap a rencontré une erreur inattendue. L'action n'a peut-être pas abouti : vérifiez son résultat, puis réessayez. Si elle se répète, lancez pap doctor.",
  ],
  "error.offline": [
    "pap is unreachable: this page cannot reach the daemon. Your drafts stay on this device. Check that pap is running, then retry.",
    "pap est injoignable : cette page n'atteint pas le daemon. Vos brouillons restent sur cet appareil. Vérifiez que pap tourne, puis réessayez.",
  ],
};

describe("error copy", () => {
  it("the eight rewritten errors have their exact EN and FR values", () => {
    expect(Object.keys(EXPECTED)).toHaveLength(8);
    for (const [key, [english, french]] of Object.entries(EXPECTED)) {
      expect((en as Record<string, string>)[key], key).toBe(english);
      expect((fr as Record<string, string>)[key], key).toBe(french);
    }
  });

  it("an unknown code falls back to the three-part internal error", () => {
    const key = errorKey("teapot");
    expect(key).toBe("error.internal");
    expect((en as Record<string, string>)[key]).toBe(EXPECTED["error.internal"]?.[0]);
    expect((fr as Record<string, string>)[key]).toBe(EXPECTED["error.internal"]?.[1]);
  });

  it("split and pane use one vocabulary in EN and FR", () => {
    expect(shellEn["shell.tabs.split"]).toBe("Split the pane");
    expect(shellEn["shell.tabs.unsplit"]).toBe("Close the split");
    expect(shellFr["shell.tabs.split"]).toBe("Scinder le volet");
    expect(shellFr["shell.tabs.unsplit"]).toBe("Fermer la scission");
    expect(shellFr["shell.pane.choose"]).toBe("Afficher dans ce volet");
    expect(shellEn["shell.tabs.split"]).toBe(lanesEn["lanes.pane.split"]);
    expect(shellEn["shell.tabs.unsplit"]).toBe(lanesEn["lanes.pane.unsplit"]);
    expect(shellFr["shell.tabs.split"]).toBe(lanesFr["lanes.pane.split"]);
    expect(shellFr["shell.tabs.unsplit"]).toBe(lanesFr["lanes.pane.unsplit"]);
  });
});

describe("error.unavailable", () => {
  it("has its exact EN and FR copy", () => {
    expect((en as Record<string, string>)["error.unavailable"]).toBe(
      "Previews are not available: pap could not open its preview port. See pap doctor.",
    );
    expect((fr as Record<string, string>)["error.unavailable"]).toBe(
      "Les aperçus ne sont pas disponibles : pap n'a pas pu ouvrir son port d'aperçu. Voir pap doctor.",
    );
  });
});
