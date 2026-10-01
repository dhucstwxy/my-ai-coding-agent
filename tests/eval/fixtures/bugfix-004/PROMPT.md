# 任务

修复 `paginate(items, page, pageSize)` 在边界页返回错误切片的问题。页码从 1 开始；超出范围返回空数组；最后一页可不足 pageSize。

不要修改测试文件。
