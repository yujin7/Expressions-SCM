import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

/**
 * ESLint 配置（2026-07-26 引入）。
 *
 * 为什么现在才装：仓里长期有 65 条 `eslint-disable` 注释，而 eslint 从未安装、
 * 无配置、无脚本、无 CI——那 65 条豁免指向一个不存在的检查器，等于 65 句假话。
 * 装上之后它们才重新变成真实信息（「这个 any 是刻意的」）。
 *
 * 为什么值得装：本项目最贵的几个缺陷都不是单测抓到的，是**静态扫描**抓到的
 * （24 页水合失败、客户端值导入服务端、落盘根目录、裸 req.json）。
 * tests/architecture/* 已经是自建的静态护栏，eslint 是同一策略的通用化。
 */
const config = [
  {
    ignores: [
      ".next/**", "node_modules/**", "drizzle/**", ".data/**",
      "uploads/**", "reports/**", "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
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
];

export default config;
