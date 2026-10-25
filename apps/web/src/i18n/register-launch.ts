import { launchProgressEn, launchProgressFr } from "./catalog/launch-progress.ts";
import { registerCatalog } from "./index.ts";

// Every lazy chunk that shows a launch (the step panel, the activity list, a waiting reason) imports this file first.
registerCatalog({ en: launchProgressEn, fr: launchProgressFr });
