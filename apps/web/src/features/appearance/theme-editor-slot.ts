import { createContext } from "react";

/** The page's right column, where the theme editor sits when there is room (board 08); null: no column, the editor is a sheet. */
export const ThemeEditorSlot = createContext<HTMLElement | null>(null);

/** Tailwind `lg`: the column needs this width beside the settings form. */
export const COLUMN_QUERY = "(min-width: 1024px)";
