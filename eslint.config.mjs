import nextPlugin from "@next/eslint-plugin-next";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Native ESLint 9 flat configuration.
 *
 * Do not route Next 15's legacy eslintrc through FlatCompat here. Its
 * @rushstack module-resolution patch cannot identify ESLint's caller on Node
 * 24, so the lint gate crashes before reading a source file. Loading the same
 * plugin rule sets directly keeps the gate deterministic on the project's
 * declared Node 24 runtime.
 */
const config = [
  {
    ignores: [
      ".next/**", ".next-*/**", ".cache/**", ".cache-cleanup-trash/**",
      "node_modules/**", "drizzle/**", ".data/**", ".artifacts/**",
      "coverage/**", "uploads/**", "reports/**", "next-env.d.ts",
      ".claude/**", // 并行 worktree（.claude/worktrees/*）与技能文档不进主仓 lint
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@next/next": nextPlugin,
      "@typescript-eslint": tsPlugin,
      import: importPlugin,
      "jsx-a11y": jsxA11y,
      react,
      "react-hooks": reactHooks,
    },
    settings: {
      react: { version: "detect" },
      "import/parsers": {
        "@typescript-eslint/parser": [".js", ".jsx", ".ts", ".tsx", ".d.ts"],
      },
      "import/resolver": {
        node: { extensions: [".js", ".jsx", ".ts", ".tsx"] },
        typescript: { alwaysTryTypes: true },
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...tsPlugin.configs.recommended.rules,
      "import/no-anonymous-default-export": "warn",
      "react/no-unknown-property": "off",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react/jsx-no-target-blank": "off",
      "jsx-a11y/alt-text": ["warn", { elements: ["img"], img: ["Image"] }],
      "jsx-a11y/aria-props": "warn",
      "jsx-a11y/aria-proptypes": "warn",
      "jsx-a11y/aria-unsupported-elements": "warn",
      "jsx-a11y/role-has-required-aria-props": "warn",
      "jsx-a11y/role-supports-aria-props": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    /**
     * 服务端日志唯一收口 `src/server/core/logger.ts`：裸 console 行没有 ts/pid/level，
     * 落到容器日志里既不可按 level 过滤也拼不回请求上下文。
     * 2026-09-04 清理审计 #7：todo/service.ts 是 src/server/** 里仅剩的两处裸 console，
     * 已改走 log()；这条规则保证下一处在门禁上就被挡住，而不是靠下一次人工审计发现。
     */
    files: ["src/server/**/*.{ts,tsx}"],
    rules: {
      "no-console": "error",
    },
  },
  {
    /**
     * logger 自己就是那个收口（log() 按 level 决定写 stdout 还是 stderr），
     * 项目未引 pino，console 是它唯一的出口——这是规则的定义性例外，不是豁免欠账。
     * 放在 flat config 而不是行内 eslint-disable：例外只此一个文件，写在配置里可被一眼复核。
     */
    files: ["src/server/core/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
];

export default config;
