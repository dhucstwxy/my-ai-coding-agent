# MewCode

终端 AI 编程助手（本轮：交互式流式多轮对话 TUI）。

## 要求

- Node.js >= 20
- DeepSeek API Key（默认联调模型 `deepseek-v4-flash`）

## 安装

```bash
npm install
```

## 配置

复制示例配置：

```bash
# Windows PowerShell
Copy-Item .mewcode\config.example.yaml .mewcode\config.yaml
```

编辑 `.mewcode/config.yaml`：

- 默认 `active: deepseek`
- `protocol: openai`
- `model: deepseek-v4-flash`
- `base_url: https://api.deepseek.com`
- `api_key`：可写密钥，或写 `${MEWCODE_API_KEY}` 从环境变量读取

也可将配置放在用户目录 `~/.mewcode/config.yaml`。**项目内配置优先。**

### API Key 环境变量（推荐 Docker / CI）

优先级从高到低：

1. `MEWCODE_<供应商名>_API_KEY`（如 `MEWCODE_DEEPSEEK_API_KEY`）
2. `MEWCODE_API_KEY`（覆盖当前 `active` 供应商）
3. yaml 中的 `api_key`（支持 `${VAR}`）

```powershell
$env:MEWCODE_API_KEY = "sk-xxx"
npm start
```

切换 Anthropic：取消注释示例中的 anthropic 供应商，并把 `active` 改成对应 `name`。

## 启动

开发（tsx 直接跑源码）：

```bash
npm start
```

生产构建（编译到 `dist/`，再用 Node 运行）：

```bash
npm run build
npm run start:prod
```

操作：

- 启动后选择「新建会话」或历史会话
- Enter 发送，Esc 返回会话列表
- 会话保存在项目内 `.mewcode/sessions/`

## 无头运行（CI / 批处理）

不启动 TUI，给一句 prompt，跑完退出并写出 `result.json`：

```bash
# 开发
npm run run -- --prompt "只回复：pong" --timeout-ms 60000

# 或从文件
npm run run -- --prompt-file PROMPT.md --out ./result.json
```

退出码：`0` 正常完成；`1` 参数/配置错误；`2` Agent 失败或超时。

Docker（不需要 `-it`）：

```powershell
docker run --rm `
  -e MEWCODE_API_KEY="sk-xxx" `
  -v "${PWD}:/workspace" `
  -w /workspace `
  mewcode:local `
  run --prompt "只回复：pong" --out /workspace/result.json
```

## Docker（开发者容器）

把运行时固定进镜像；配置与工作区用挂载，**不要把 api_key 打进镜像**。

若直连 Docker Hub 超时（国内常见），在 Docker Desktop → Settings → Docker Engine 增加后 Apply & Restart：

```json
"registry-mirrors": ["https://docker.m.daocloud.io"]
```

或手动拉基础镜像再打标签：

```bash
docker pull docker.m.daocloud.io/library/node:20-bookworm-slim
docker tag docker.m.daocloud.io/library/node:20-bookworm-slim node:20-bookworm-slim
```

```bash
# 构建镜像
docker build -t mewcode:local .

# 交互运行（TUI 必须加 -it；密钥用 -e 注入）
# Windows PowerShell 示例
docker run --rm -it `
  -e MEWCODE_API_KEY="sk-xxx" `
  -v "${PWD}:/workspace" `
  -v "$env:USERPROFILE\.mewcode:/root/.mewcode" `
  -w /workspace `
  mewcode:local
```

说明：

- `/workspace`：要改的代码仓库（需含 `.mewcode/config.yaml`，或依赖挂载的 `~/.mewcode`）
- `/root/.mewcode`：用户级配置 / 记忆等持久化目录
- 镜像内已含 `git`、`tmux`；团队模式请在 tmux 会话内启动
- 评测：`docker run --rm -e MEWCODE_API_KEY=sk-xxx -v "${PWD}:/workspace" -w /workspace mewcode:local eval --help`
- 无头：`docker run --rm -e MEWCODE_API_KEY=sk-xxx -v "${PWD}:/workspace" -w /workspace mewcode:local run --help`

## 文档

本轮 spec / plan / task / checklist 见 `docs/01-tui-streaming-chat/`。
