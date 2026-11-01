# ---- 阶段 1：编译 TypeScript → dist/ ----
FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 阶段 2：Node 运行时（两个目标共用）----
FROM node:20-bookworm-slim AS node-runtime

# git：worktree / 工具命令；tmux：团队模式；ca-certificates：HTTPS 调模型 API
RUN apt-get update \
  && apt-get install -y --no-install-recommends git tmux ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

# ---- 阶段 3：HTTP 服务。docker build --target server ----
# Python 接口拉起同一个镜像里的 Node 执行器（node dist/index.js serve-worker）。
FROM node-runtime AS server

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/mewcode

COPY server/requirements.txt /app/server/requirements.txt
RUN /opt/mewcode/bin/pip install --no-cache-dir -r /app/server/requirements.txt

COPY server/mewcode_api /app/server/mewcode_api

# 数据目录和工作区用卷挂出。镜像内先建目录，匿名卷也有落点。
RUN mkdir -p /var/lib/mewcode /workspace

ENV MEWCODE_SERVER_HOST=0.0.0.0 \
    MEWCODE_SERVER_PORT=8787 \
    MEWCODE_SERVER_DATA=/var/lib/mewcode \
    MEWCODE_WORKSPACE=/workspace \
    PYTHONUNBUFFERED=1 \
    MEWCODE_WORKER_CMD="[\"node\",\"/app/dist/index.js\",\"serve-worker\"]"

VOLUME ["/var/lib/mewcode", "/workspace"]
EXPOSE 8787

# 监听 0.0.0.0。未设置 MEWCODE_SERVER_TOKEN 时进程直接退出。
ENTRYPOINT ["/opt/mewcode/bin/python", "/app/server/mewcode_api/__main__.py"]

# ---- 阶段 4：终端镜像，默认构建目标。docker build --target cli ----
FROM node-runtime AS cli

# 默认工作区挂载点；启动时请 -v <宿主机仓库>:/workspace
WORKDIR /workspace

# TUI 需要交互终端：docker run 时加 -it
ENTRYPOINT ["node", "/app/dist/index.js"]
# 无参数 = 交互 TUI；也可传 eval 等子命令，例如：docker run ... mewcode eval --help
CMD []
