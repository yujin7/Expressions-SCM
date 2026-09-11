import type { NextConfig } from "next";
import { readBuildIdentity } from "./scripts/build-identity";

const buildIdentity = readBuildIdentity(process.cwd(), process.env.SCM_BUILD_REVISION);

const nextConfig: NextConfig = {
  // Non-secret literals baked by Next into the compiled health route; changing
  // runtime env cannot make an old artifact claim a newer source revision.
  env: {
    SCM_COMPILED_REVISION: buildIdentity.revision ?? "",
    SCM_COMPILED_SOURCE: buildIdentity.source,
  },
  reactStrictMode: true,
  // Next 15 otherwise rewrites loopback redirect origins (127.0.0.1 / [::1])
  // to localhost, moving the browser to a different host-only cookie jar.
  // This is a build-time flag; middleware still validates the actual Host and
  // emits absolute Locations. See tests/auth/login-origin-adapter.test.ts.
  skipMiddlewareUrlNormalize: true,
  // Development sessions use .next-dev/.next-webpack so a production build
  // cannot invalidate the active HMR cache. CI and `npm run build` keep .next.
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",
  output: "standalone", // 生产容器化（ops/Dockerfile）
  // 本地恢复证据和用户文件由运行时卷/目录提供，绝不能被文件追踪复制进 standalone。
  // Docker 构建另有 .dockerignore 双重防线；这里同时保护本地 release build。
  outputFileTracingExcludes: {
    "/**": [
      "./.data/**/*",
      "./backups/**/*",
      "./uploads/**/*",
      "./.artifacts/**/*",
      "./.next-*/**/*",
      "./tmp/**/*",
    ],
  },
  // 服务器组件里用到的原生依赖
  serverExternalPackages: ["pg", "pg-boss", "@node-rs/argon2", "exceljs", "@electric-sql/pglite"],

  /**
   * 安全响应头（R9，来自运行时安全审计）。
   *
   * 基线头覆盖点击劫持、MIME 嗅探、敏感来源泄露和常见资源注入。
   * 最要紧的是防嵌套：本系统的核心原则是"自动化只出草稿，闸门永远是人"，
   * 审批按钮就是那个闸门。没有防嵌套头，审批页可被任意站点 iframe 进去，
   * 叠一层透明层诱导已登录的审批人点到"审批通过"——点击劫持直接攻击的
   * 是我们唯一的人工控制点。
   *
   * CSP 保留 Next 引导脚本和 AntD css-in-js 当前必需的 inline 兼容，但把 object、frame、
   * base、form、connect 等来源收紧到系统实际需要的范围。HSTS 只在 HTTPS 构建开关开启。
   */
  async headers() {
    const scriptSrc = process.env.NODE_ENV === "development"
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";
    // Next 的引导脚本及 AntD css-in-js 当前需要 inline；其余来源全部收紧。
    // 后续若引入 request nonce，可再去掉 script-src 的 unsafe-inline。
    const contentSecurityPolicy = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // 跳外链时不泄露内部路径（路径里带单号、SKU 编码）
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          /*
           * HSTS 只在确认走 HTTPS 后才开。明文 HTTP 时开会把自己锁在门外——
           * 浏览器记住后强制跳 https，而局域网 http://<ip>:3100 没有证书，直接打不开。
           *
           * ⚠ 这是**构建期**开关，不是运行期开关。
           * `headers()` 由 `next build` 求值后烘焙进 .next/routes-manifest.json，
           * 运行期再设 PUBLIC_HTTPS 对已构建的镜像毫无作用。
           * 2026-08-07 实测：容器 env 里 PUBLIC_HTTPS=1，但 routes-manifest 中
           * 没有 Strict-Transport-Security，响应头也确实没有——之前把它接在
           * compose 的 environment 上属于无效配置，现已改为 Dockerfile 的 build arg。
           *
           * 要真正启用：docker compose build --build-arg PUBLIC_HTTPS=1 app
           * 由 tests/architecture/build-time-env.test.ts 钉住「构建期 env 必须有对应 ARG」。
           */
          ...(process.env.PUBLIC_HTTPS === "1"
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
      {
        source: "/login",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
        ],
      },
      {
        source: "/api/auth/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
        ],
      },
    ];
  },
};

export default nextConfig;
