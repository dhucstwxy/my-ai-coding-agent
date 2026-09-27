---
name: commit
description: 根据当前改动准备一次 git 提交
tools:
  - read_file
  - glob_files
  - grep_search
  - run_command
mode: shared
---

按下面的步骤准备提交，不要推送到远程。

用户补充：$ARGUMENTS

1. 用只读工具查看工作区状态和差异，确认哪些改动应该纳入本次提交。
2. 不要提交密钥、本地配置或明显的调试垃圾。
3. 用 run_command 执行 git add 与 git commit。说明用一两句中文写清为什么改。
4. 完成后用简短条目告诉用户提交了什么。
