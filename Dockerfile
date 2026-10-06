# ---- 阶段 1：编译 TypeScript → dist/ ----
FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 阶段 2：精简运行镜像 ----
FROM node:20-bookworm-slim AS runner

# git：worktree / 工具命令；tmux：团队模式；ca-certificates：HTTPS 调模型 API
RUN apt-get update \
  && apt-get install -y --no-install-recommends git tmux ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=builder /app/dist ./dist

# 默认工作区挂载点；启动时请 -v <宿主机仓库>:/workspace
WORKDIR /workspace

ENV NODE_ENV=production

# TUI 需要交互终端：docker run 时加 -it
ENTRYPOINT ["node", "/app/dist/index.js"]
# 无参数 = 交互 TUI；也可传 eval 等子命令，例如：docker run ... mewcode eval --help
CMD []
