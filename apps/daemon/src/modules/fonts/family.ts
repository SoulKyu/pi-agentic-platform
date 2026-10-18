import { FONT_FAMILY_PATTERN } from "@pap/contracts";

/** The trust-boundary rule for a family name: letters, digits and spaces, nothing a URL or a path could use. */
export const validFamily = (name: string): boolean => FONT_FAMILY_PATTERN.test(name);

/** One space between words, none at the end: the name pap stores and puts in a URL. */
export const canonicalFamily = (name: string): string => name.trim().replace(/ +/g, " ");

/** The folder name and the URL segment of a family: `Open Sans` becomes `open-sans`. */
export const slugOf = (family: string): string => canonicalFamily(family).toLowerCase().replace(/ /g, "-");
