# 斜杠命令验收报告

## 环境

- 日期：2026-09-27
- 本机无 tmux，端到端以无头打桩 + typecheck 为主；场景 5（真实 `/review` 流式）待交互确认

## 结果摘要

| 项 | 结果 |
|----|------|
| typecheck | 通过 |
| 临时验证脚本（28 项，已删） | 通过 |
| 旧 parse* 残留 | 无 |
| 十命令注册 /perm 别名 | 通过 |
| 未知命令不调 Provider | 通过 |
| 普通文本调 Provider | 通过 |

## 实现要点

- `src/commands/*`：registry / parse / dispatch / complete + 十个 builtin
- `ChatService.send` 先 dispatch；`submitToAgent` → `runAgent` 不二次解析
- TUI：`[PLAN\|DEFAULT · STRICT\|DEFAULT\|ALLOW]`、Tab 补全、`ui_message`/`ui_clear`
- CLI：`buildDefaultRegistry`，冲突 `CommandConflictError` → `exit(1)`

## 未交互确认

- [ ] 真实终端 Tab 手感
- [ ] `/review` 实呼模型全文
- [ ] `/clear` 后目视空屏再 Esc 重开
