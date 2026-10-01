# SSIO 服务端镜像（多阶段：编译在 build 阶段，运行镜像只带运行产物与运行时依赖）
#
# 本机构建：docker build -t ssio:latest .
# 直接用 compose：docker compose up -d（读 .env 里的 JWT_SECRET / MASTER_KEY）

# ---------- 构建阶段 ----------
FROM node:22-bookworm-slim AS build

# corepack 固定 pnpm 版本，避免镜像默认版本与 lockfile 不一致
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate

WORKDIR /app

# 先只拷清单文件，最大化构建缓存命中
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs .npmrc ./
COPY packages ./packages

# --filter '!electron-min'：Electron 示例的 devDep 会拉 110 MB 的 Electron，服务端镜像不需要它。
# 不加 --ignore-scripts：better-sqlite3 要靠 install 脚本取预编译二进制；
# 不用 pnpm deploy 导出运行目录：deploy 只复制包清单里的文件，会漏掉 install 脚本生成的
# build/Release/*.node（本机实测过，产物里 require 得到包但实例化时找不到二进制）。
RUN pnpm install --frozen-lockfile --filter '!electron-min'

# 只构建服务端与其依赖的 shared（core/web/node 是 SDK，不进服务端镜像）
RUN pnpm --filter @ssio/shared --filter @ssio/server build

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8100

RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /app

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc /app/
COPY --from=build /app/packages/shared/package.json /app/packages/shared/
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/server/package.json /app/packages/server/
COPY --from=build /app/packages/server/dist /app/packages/server/dist
# 迁移文件：启动时 runMigrations 要读，缺了服务起不来
COPY --from=build /app/packages/server/drizzle /app/packages/server/drizzle

# 只装运行时依赖（devDependencies 不进镜像）。better-sqlite3 的预编译二进制
# 就在这一步由 install 脚本生成；rebuild 是双保险（换基础镜像/架构时必备）。
RUN pnpm install --frozen-lockfile --prod --filter '@ssio/server...' && pnpm rebuild better-sqlite3

# 数据目录归 node 用户：运行阶段用 USER node，root 属主的目录写不进去
RUN mkdir -p /data && chown -R node:node /data

EXPOSE 8100
VOLUME ["/data"]
USER node

# /v1/readyz 会真查一次数据库（比 /v1/healthz 更实），适合做存活探针
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8100)+'/v1/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
