const RAW_COLOR =
  /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/;
const ARBITRARY = /(?:^|\s)[!\w:/.-]*-\[[^\]\s]+\]/;

// Padding, margin, gap and space utilities with a Tailwind number (`p-2`, `-mt-1`, `md:gap-4`). 0, 0.5 (a 2 px optical
// offset, under the smallest token) and `px` are not spacing steps. The scale is `s1`..`s6`, which the density follows.
const NUMERIC_SPACING =
  /(?<![\w-])-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])-(?!(?:0|0\.5)(?![\w.-]))\d+(?:\.\d+)?(?![\w.-])/;

function stringRule(messageId, message, pattern) {
  return {
    meta: { type: "problem", messages: { [messageId]: message }, schema: [] },
    create(context) {
      const check = (node, value) => {
        if (typeof value === "string" && pattern.test(value)) context.report({ node, messageId });
      };
      return {
        Literal: (node) => check(node, node.value),
        TemplateElement: (node) => check(node, node.value.cooked ?? node.value.raw),
      };
    },
  };
}

const noRestyle = {
  meta: {
    type: "problem",
    messages: {
      restyle: "Do not restyle the @pap/ui primitive {{name}}: add a variant to the primitive instead.",
    },
    schema: [],
  },
  create(context) {
    const uiNames = new Set();
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "@pap/ui") return;
        for (const specifier of node.specifiers) uiNames.add(specifier.local.name);
      },
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || !uiNames.has(node.name.name)) return;
        for (const attribute of node.attributes) {
          if (attribute.type === "JSXAttribute" && ["className", "style"].includes(attribute.name.name)) {
            context.report({ node: attribute, messageId: "restyle", data: { name: node.name.name } });
          }
        }
      },
    };
  },
};

const zustandSelector = {
  meta: {
    type: "problem",
    messages: { selector: "Read a zustand store through a selector: {{name}}((state) => state.part)." },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          /^use[A-Z]\w*Store$/.test(node.callee.name) &&
          node.arguments.length === 0
        ) {
          context.report({ node, messageId: "selector", data: { name: node.callee.name } });
        }
      },
    };
  },
};

// DESIGN.md §7.1: icon-only controls carry a tooltip; the native title attribute is not used (T3:
// oxlint-plugin-t3code/rules/no-native-title-tooltip.ts). Embedded content keeps title: it names the frame there.
const TITLE_EXEMPT = new Set(["iframe", "embed", "frame", "object", "math"]);

const noNativeTitle = {
  meta: {
    type: "problem",
    messages: {
      title: "Do not use the native title attribute: use the Tooltip of @pap/ui (DESIGN.md §7.1).",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (
          node.name.type !== "JSXIdentifier" ||
          !/^[a-z]/.test(node.name.name) ||
          TITLE_EXEMPT.has(node.name.name)
        )
          return;
        for (const attribute of node.attributes) {
          if (attribute.type === "JSXAttribute" && attribute.name.name === "title") {
            context.report({ node: attribute, messageId: "title" });
          }
        }
      },
    };
  },
};

export default {
  meta: { name: "pap" },
  rules: {
    "no-raw-colors": stringRule(
      "raw",
      "Raw colour in UI code: use a token from packages/ui/src/tokens.css.",
      RAW_COLOR,
    ),
    "no-arbitrary-values": stringRule(
      "arbitrary",
      "Arbitrary Tailwind value: use the token scale.",
      ARBITRARY,
    ),
    "no-numeric-spacing": stringRule(
      "numeric",
      "Numeric spacing utility: use the s1..s6 tokens so the density applies (p-s2, gap-s3).",
      NUMERIC_SPACING,
    ),
    "no-restyle": noRestyle,
    "no-native-title": noNativeTitle,
    "zustand-selector": zustandSelector,
  },
};
