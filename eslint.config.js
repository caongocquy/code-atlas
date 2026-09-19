import eslint from "@eslint/js";
import babelParser from "@babel/eslint-parser";

const typescriptParserOptions = (isTSX) => ({
  requireConfigFile: false,
  babelOptions: {
    plugins: [
      ["@babel/plugin-syntax-typescript", { isTSX }],
      ...(isTSX ? ["@babel/plugin-syntax-jsx"] : []),
    ],
  },
});

export default [
  {
    ignores: ["dist/**", "node_modules/**", ".gitnexus/**", "eval/context/corpus/snapshots/**", "eslint.config.js"],
  },
  eslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts", "web/**/*.ts"],
    languageOptions: {
      parser: babelParser,
      parserOptions: typescriptParserOptions(false),
    },
    rules: {
      // TypeScript's compiler owns undefined-name checking for these files.
      "no-undef": "off",
      // Babel parses TypeScript syntax but does not provide TypeScript-aware scopes.
      "no-unused-vars": "off",
      // This test intentionally checks ANSI escape sequences.
      "no-control-regex": "off",
    },
  },
  {
    files: ["web/**/*.tsx"],
    languageOptions: {
      parser: babelParser,
      parserOptions: typescriptParserOptions(true),
    },
    rules: {
      // TypeScript's compiler owns undefined-name checking for these files.
      "no-undef": "off",
      // Babel parses TypeScript syntax but does not provide TypeScript-aware scopes.
      "no-unused-vars": "off",
    },
  },
];
