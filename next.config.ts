import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Development sessions use .next-dev/.next-webpack so a production build
  // cannot invalidate the active HMR cache. CI and `npm run build` keep .next.
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",
  output: "standalone", // 生产容器化（ops/Dockerfile）
  // 服务器组件里用到的原生依赖
  serverExternalPackages: ["pg", "pg-boss", "@node-rs/argon2", "exceljs", "@electric-sql/pglite"],

  /**
   * 安全响应头（R9，来自运行时安全审计）。
   *
   * 这里只放**不可能弄坏 AntD/recharts** 的四个头。
   * 最要紧的是防嵌套：本系统的核心原则是"自动化只出草稿，闸门永远是人"，
   * 审批按钮就是那个闸门。没有防嵌套头，审批页可被任意站点 iframe 进去，
   * 叠一层透明层诱导已登录的审批人点到"审批通过"——点击劫持直接攻击的
   * 是我们唯一的人工控制点。
   *
   * 刻意不在这里加：
   * - CSP：AntD 5 大量运行时内联样式，未经真实页面验证的策略会静默弄坏
   *   图表与导出。必须走 Report-Only → 跑遍审批/图表/导出/Excel导入 →
   *   收敛 → 强制，作为独立任务做。
   * - HSTS：只在确认生产全站 https 后再加，否则会把自己锁在门外。
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // 跳外链时不泄露内部路径（路径里带单号、SKU 编码）
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
