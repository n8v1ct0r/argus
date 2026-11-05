import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Cesium is never bundled: @argus/globe loads the prebuilt Cesium.js at runtime (Turbopack's
// minifier breaks Cesium's source). Type-only imports are fine. Ion is never used either.
const cesiumBan = {
  name: "cesium",
  allowTypeImports: true,
  message:
    "Import Cesium types only. @argus/globe loads Cesium at runtime (see packages/globe/src/runtime.ts).",
};

// Model rule 1: only src/model/ may talk to the Claude API, and only route handlers import src/model/.
const anthropicBan = {
  name: "@anthropic-ai/sdk",
  message: "Only src/model/ may import the Anthropic SDK. Everything else calls a server route.",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: [cesiumBan, anthropicBan] }],
    },
  },
  {
    files: ["src/model/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: [cesiumBan] }],
    },
  },
  {
    // The globe package may not know about the app: no app aliases, no Next, no app paths.
    files: ["packages/globe/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [cesiumBan, anthropicBan],
          patterns: [
            { group: ["@/*", "next", "next/*"], message: "@argus/globe must stay framework-free." },
            {
              group: ["**/src/app/**", "../../src/**", "../../../src/**"],
              message: "@argus/globe may not import app code.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/cesium/**",
    "data/**",
    "test-results/**",
    "playwright-report/**",
    ".local/**",
    ".claude/**",
  ]),
]);

export default eslintConfig;
