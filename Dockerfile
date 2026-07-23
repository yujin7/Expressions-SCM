# 生产镜像（01 §1.2/§8）：多阶段构建 → standalone 运行时
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
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
USER scm
EXPOSE 3000
CMD ["node", "server.js"]
