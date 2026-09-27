---
name: review
description: 审查当前工作并给出风险与建议
tools:
  - read_file
  - glob_files
  - grep_search
mode: shared
---

审查当前会话和近期改动，指出风险、错误和可改进点，并给出具体建议。不要改文件，也不要执行命令。

用户补充：$ARGUMENTS
