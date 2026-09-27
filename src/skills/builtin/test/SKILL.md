---
name: test
description: 运行测试并汇报结果
tools:
  - read_file
  - glob_files
  - grep_search
  - run_command
mode: shared
---

运行项目测试并汇报结果。

用户补充：$ARGUMENTS

1. 先看项目里怎么跑测试，再执行相应命令。
2. 失败时根据输出定位原因，能修则修，修完再跑一次。
3. 用简短条目说明通过、失败和你改了什么。
