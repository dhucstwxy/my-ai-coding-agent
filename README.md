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

复制示例配置并填写密钥：

```bash
# Windows PowerShell
Copy-Item .mewcode\config.example.yaml .mewcode\config.yaml
```

编辑 `.mewcode/config.yaml`：

- 默认 `active: deepseek`
- `protocol: openai`
- `model: deepseek-v4-flash`
- `base_url: https://api.deepseek.com`
- `api_key: <你的密钥>`

也可将配置放在用户目录 `~/.mewcode/config.yaml`。**项目内配置优先。**

切换 Anthropic：取消注释示例中的 anthropic 供应商，并把 `active` 改成对应 `name`。

## 启动

```bash
npm start
```

操作：

- 启动后选择「新建会话」或历史会话
- Enter 发送，Esc 返回会话列表
- 会话保存在 `~/.mewcode/sessions/`

## 文档

本轮 spec / plan / task / checklist 见 `docs/01-tui-streaming-chat/`。
