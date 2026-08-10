# 生产镜像（01 §1.2/§8）：多阶段构建 → standalone 运行时
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-minimatch-brace-api.mjs ./scripts/patch-minimatch-brace-api.mjs
RUN npm ci --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# HSTS 开关必须在**构建期**给：next.config.ts 的 headers() 由 next build 求值后
# 烘焙进 routes-manifest.json，运行期再设这个变量对已构建的镜像无效（2026-08-07 实测）。
# 走稳定 HTTPS 域名时：docker compose build --build-arg PUBLIC_HTTPS=1 app
ARG PUBLIC_HTTPS=""
ENV PUBLIC_HTTPS=${PUBLIC_HTTPS}
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# 迁移门禁专用镜像。
#
# 为什么单独一个阶段：runner 是 standalone 精简产物，虽然拷了 drizzle-kit 目录，
# 但既没有 node_modules/.bin 的 shim，也没有它的依赖（esbuild）——
# `compose run --rm app npx drizzle-kit migrate`（ops/deploy.sh 的迁移步骤）
# 实测先报 `drizzle-kit: not found`，绕开 shim 直接 `node bin.cjs` 又报
# `Cannot find module 'esbuild'`（读 drizzle.config.ts 需要它）。
# 也就是说**只要有待应用的迁移，文档里的部署流程就会失败**。
# build 阶段本来就带完整 node_modules 与源码，直接复用最省事，也不会把
# 这些开发期依赖带进运行镜像。
FROM build AS migrator
WORKDIR /app
ENV NODE_ENV=production
CMD ["npx", "drizzle-kit", "migrate"]

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN addgroup -S scm && adduser -S scm -G scm
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# public/ 必须显式拷贝：standalone 产物**不包含**它。
# 漏掉的话所有静态资源（logo、图标等）在生产一律 404，而 dev 模式下完全正常——
# 又一个只有真跑容器才会暴露的差异。
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/node_modules/drizzle-kit ./node_modules/drizzle-kit
COPY --from=build /app/drizzle.config.ts ./
# 落盘目录必须**在镜像里预先存在且属 scm**：Docker 对镜像中不存在的具名卷挂载点
# 会以 root:root 0755 创建，而运行身份是 scm —— 附件上传/Excel 导入/异步导出
# 三处写盘都会 EACCES（500 与 job failed）。FILE_STORAGE_DIR 默认 /data/uploads。
RUN mkdir -p /data/uploads && chown -R scm:scm /data/uploads
USER scm
EXPOSE 3000
CMD ["node", "server.js"]
