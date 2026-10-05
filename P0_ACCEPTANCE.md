# P0 验收记录

日期：2026-10-05。版本：dsh-chem-editor 0.0.1。

## 结果

P0 已完成，并安装到本机官方 DeepSeek Harness 桌面端 `0.2.0-rc.2` 的 `desktop` profile。

- 安装目录：`D:\AI项目\dsh-chem`。
- 官方客户端：`D:\dsh\DeepSeek Harness.exe`。
- Profile：`C:\Users\86137\.dsh\profiles\desktop`。
- 依赖：Ketcher core/react/standalone `3.7.0`；React `18.3.1`；Indigo `1.35.0`（standalone 的锁定依赖）。

## 已通过

| 检查 | 证据 |
|---|---|
| 构建 | `pnpm run build` 成功 |
| 宿主桥接 | `pnpm test` 通过；检查静态资源白名单、非法请求、会话隔离、宿主读取选区和资源释放 |
| 浏览器验收 | `pnpm run test:browser` 输出 `ALL-PASS: P0 browser acceptance` |
| 鼠标原子映射 | 浏览器与桌面端均用实际鼠标点选原子，读出原子 ID |
| 苯 → 吡啶 | 点击替换按钮，只有所选 C 改 N；浏览器用 InChI 与独立输入的吡啶结构比对一致 |
| 化学失败 | 芳香碳替换 F 的非法价态被 Indigo 拒绝，全部结构字段不变 |
| 复杂样例 | 含手性多环分子替换一个 C，比较其余原子和所有键/立体字段保持；撤销恢复 |
| 同一编辑历史 | 手工增加原子 → 程序替换 → 连续两次撤销，分别恢复替换与手工操作 |
| KET 回读 | 所有结构字段保持；坐标只允许 `1e-5` 以内的舍入误差 |
| 官方 Desktop | 实际打开分子 tab，画布完成初始化；鼠标选中 C #1 → 点击替换 → N #1 → 撤销回苯 |
| Desktop 宿主同步 | 面板显示“结构与选区已同步到 DSH 宿主”，替换/撤销后发送对应新版本 |

测试截图在本地 `test-results/pyridine.png`、`test-results/chiral.png`，不进入发布包。

## 实施中解决的问题

- DSH `conversation.session.header.corner` 是 single slot，已经被官方右侧栏按钮占用；入口最终使用 `conversation.session.header.actions` list slot。
- 入口放在会话标题旁，避免被已有 FishFM 悬浮条挡住；保留官方右侧栏的折叠和全屏机制。
- Ketcher 的独立 iframe 设置自己的 `window.ketcher`，满足该锁定版本日志和 API 的运行约定。
- 限制自定义样式只影响插件工具栏，避免覆盖 Ketcher 原生按钮。

## 保留的边界

此阶段验证程序局部修改，还没有批注驱动的 Agent 工具。宿主快照存储于内存，应用退出后不恢复结构；重要结构须导出。S-group/R-group、查询和伪原子的程序替换暂不支持。关闭面板后通过标题旁“分子”重新打开。

P1 继续文档持久化；P2 接入批注和 Agent 原子替换工具。
