import { laneCommitEn, laneCommitFr } from "../../i18n/catalog/lane-commit.ts";
import { lanesEn, lanesFr } from "../../i18n/catalog/lanes.ts";
import { registerCatalog } from "../../i18n/index.ts";

// The commit bar and the PR panel show the lane catalog's keys too (the PR state and check words).
registerCatalog({ en: { ...lanesEn, ...laneCommitEn }, fr: { ...lanesFr, ...laneCommitFr } });
