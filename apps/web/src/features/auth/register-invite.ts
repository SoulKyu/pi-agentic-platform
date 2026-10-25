import { inviteEn, inviteFr } from "../../i18n/catalog/invite.ts";
import { registerCatalog } from "../../i18n/index.ts";
import "./register-first-run.ts";

// Evaluated with the invitation chunk, before the page renders. The passkey step speaks with the first-run strings.
registerCatalog({ en: inviteEn, fr: inviteFr });
