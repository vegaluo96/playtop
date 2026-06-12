# ZSKY.COM 足球天空 —— Web + worker 双进程,同库同卷
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── Web(默认目标):standalone 由 server.js 监听 3000 ──
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# SQLite 落持久卷;worker 容器必须挂同一卷
ENV PLAYTOP_DB=/app/data/playtop.db
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server.js"]

# ── worker(数据抓取,构建时 --target worker):docker run 时挂同一 /app/data 卷 ──
FROM builder AS worker
ENV NODE_ENV=production
ENV PLAYTOP_DB=/app/data/playtop.db
VOLUME ["/app/data"]
CMD ["npx", "tsx", "scripts/worker.ts"]
