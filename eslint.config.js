import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import boundaries from "eslint-plugin-boundaries";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
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
      "@eslint-community/eslint-comments/no-restricted-disable": ["error", "max-lines", "boundaries/*"],
      "@eslint-community/eslint-comments/no-use": [
        "error",
        {
          allow: ["eslint-disable", "eslint-disable-next-line", "eslint-disable-line", "eslint-enable"],
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
            { from: "web-stores", allow: ["web-stores", "web-runtime", "contracts"] },
            {
              from: "web-feature",
              allow: [
                ["web-feature", { domain: "${from.domain}" }],
                "web-stores",
                "web-runtime",
                "web-i18n",
                "ui",
                "contracts",
              ],
            },
            { from: "web-routes", allow: ["web-routes", "web-feature", "web-runtime", "web-i18n", "ui"] },
            { from: "web-i18n", allow: ["web-i18n", "contracts"] },
            { from: "web-root", allow: ["web-root", "web-routes", "web-runtime", "web-i18n", "ui"] },
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
    ignores: ["**/*.test.ts", "**/*.test.tsx", "packages/ui/src/tokens.css"],
    plugins: { pap },
    rules: { "pap/no-raw-colors": "error" },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
    plugins: { pap, "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "pap/no-arbitrary-values": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: { "pap/no-restyle": "error", "pap/zustand-selector": "error" },
  },
);
