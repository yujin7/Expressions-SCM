import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 服务器组件里用到的原生依赖
  serverExternalPackages: ["pg", "pg-boss", "@node-rs/argon2", "exceljs", "@electric-sql/pglite"],
};

export default nextConfig;
