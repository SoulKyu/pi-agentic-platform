import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import boundaries from "eslint-plugin-boundaries";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import * as espree from "espree";
import globals from "globals";
import tseslint from "typescript-eslint";
import pap from "./eslint/pap-plugin.js";

const ELEMENTS = [
  { type: "contracts", pattern: "packages/contracts/src" },
  { type: "ui", pattern: "packages/ui/src" },
  { type: "pi-host", pattern: "packages/pi-host/src" },
  { type: "kernel", pattern: "apps/daemon/src/kernel" },
  { type: "daemon-testing", pattern: "apps/daemon/src/**/testing" },
  { type: "module", pattern: "apps/daemon/src/modules/*", capture: ["domain"] },
  { type: "daemon-root", pattern: "apps/daemon/src/*.ts", mode: "file" },
  { type: "web-runtime", pattern: "apps/web/src/runtime" },
  { type: "web-lib", pattern: "apps/web/src/lib" },
  { type: "web-stores", pattern: "apps/web/src/stores" },
  { type: "web-feature", pattern: "apps/web/src/features/*", capture: ["domain"] },
  { type: "web-routes", pattern: "apps/web/src/routes" },
  { type: "web-i18n", pattern: "apps/web/src/i18n" },
  { type: "web-root", pattern: "apps/web/src/*.{ts,tsx}", mode: "file" },
];

export default defineConfig(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "spikes/**",
      "docs/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  comments.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "max-lines": ["error", { max: 400, skipBlankLines: false, skipComments: false }],
      "@eslint-community/eslint-comments/require-description": "error",
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      // The guards cannot be switched off from inside a file, including these two (a disable of a restricted
      // rule is itself reported, so "disable no-restricted-disable, then disable max-lines" does not pass).
      "@eslint-community/eslint-comments/no-restricted-disable": [
        "error",
        "max-lines",
        "boundaries/*",
        "@eslint-community/eslint-comments/*",
      ],
      "@eslint-community/eslint-comments/no-use": [
        "error",
        {
          // Only -next-line: a block or -line directive also covers the report about itself (R64b).
          allow: ["eslint-disable-next-line"],
        },
      ],
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": ELEMENTS,
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          conditionNames: ["development", "types", "import", "default"],
          project: ["apps/*/tsconfig.json", "packages/*/tsconfig.json"],
          noWarnOnMultipleProjects: true,
        },
      },
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            { from: "contracts", allow: ["contracts"] },
            { from: "ui", allow: ["ui"] },
            { from: "pi-host", allow: ["pi-host", "contracts"] },
            { from: "kernel", allow: ["kernel", "contracts", "daemon-testing"] },
            { from: "module", allow: ["contracts", "kernel", "module", "daemon-testing"] },
            {
              from: "daemon-testing",
              allow: ["contracts", "kernel", "module", "daemon-root", "daemon-testing"],
            },
            {
              from: "daemon-root",
              allow: ["contracts", "kernel", "module", "daemon-root", "daemon-testing"],
            },
            { from: "web-runtime", allow: ["web-runtime", "contracts"] },
            { from: "web-lib", allow: ["web-lib", "web-runtime", "contracts"] },
            { from: "web-stores", allow: ["web-stores", "web-runtime", "contracts"] },
            {
              from: "web-feature",
              allow: [
                ["web-feature", { domain: "${from.domain}" }],
                "web-stores",
                "web-runtime",
                "web-lib",
                "web-i18n",
                "ui",
                "contracts",
              ],
            },
            {
              from: "web-routes",
              allow: ["web-routes", "web-feature", "web-runtime", "web-lib", "web-i18n", "ui", "contracts"],
            },
            { from: "web-i18n", allow: ["web-i18n", "web-lib", "contracts"] },
            {
              from: "web-root",
              allow: ["web-root", "web-routes", "web-runtime", "web-lib", "web-feature", "web-i18n", "ui"],
            },
          ],
        },
      ],
      "boundaries/entry-point": [
        "error",
        {
          default: "disallow",
          rules: [
            { target: ["module"], allow: "index.ts" },
            {
              target: [
                "contracts",
                "ui",
                "pi-host",
                "kernel",
                "daemon-root",
                "daemon-testing",
                "web-runtime",
                "web-lib",
                "web-stores",
                "web-feature",
                "web-routes",
                "web-i18n",
                "web-root",
              ],
              allow: "**",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/daemon/src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/testing/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/testing/*"],
              message: "Test helpers are not part of the build: production daemon code must not import them.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/(^|\\/)testing\\//]",
          message: "Test helpers are not part of the build: production daemon code must not import them.",
        },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
    // Colour data and colour math, each pinned by its tests (M3-RT-02). Nothing else may hold a raw colour.
    ignores: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "packages/ui/src/tokens.css",
      "packages/ui/src/presets.ts",
      "apps/web/src/features/appearance/contrast.ts",
      "apps/web/src/features/appearance/derive.ts",
    ],
    plugins: { pap },
    rules: { "pap/no-raw-colors": "error" },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
    plugins: { pap, "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "pap/no-arbitrary-values": "error",
      "pap/no-native-title": "error",
      // The React Compiler skips a component that breaks these rules without saying so: take the whole
      // recommended preset (refs, purity, immutability, set-state-in-render...), with no rule left a warning.
      ...Object.fromEntries(
        Object.keys(reactHooks.configs.flat.recommended.rules).map((rule) => [rule, "error"]),
      ),
    },
  },
  {
    files: ["apps/web/src/**/*.js"],
    languageOptions: {
      parser: espree,
      ecmaVersion: 2019,
      sourceType: "script",
      globals: { ...globals.browser },
    },
    // The typescript-eslint scope rules need its own parser; a classic script is checked by the core rule.
    rules: { "@typescript-eslint/no-unused-vars": "off", "no-unused-vars": "error" },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: { "pap/no-restyle": "error", "pap/zustand-selector": "error" },
  },
);
