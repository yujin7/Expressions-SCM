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
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN addgroup -S scm && adduser -S scm -G scm
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
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
