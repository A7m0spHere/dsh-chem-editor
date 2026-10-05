# P2 验收记录

日期：2026-10-05。版本：`dsh-chem-editor 0.0.3`。

## 功能与范围

已实现单条 Agent 批注、冻结单个原子选区、原生工具读取上下文与提交元素替换、Indigo 验证、修改前后 SVG 预览、人工应用/取消、自动保存和撤销。每个会话同时一条活动批注。

模型工具按 `exec.agent.session.id` 获取调用会话，不接收客户端指定的另一个会话标识。目标使用编辑器实例、文档版本、冻结原子 ID 和 KET 地址共同定位。后来选择别的原子不改变目标；文档变化、取消、重开会阻止旧方案应用。

批注单独写入工作区 journal。分子提交使用 P1 的内容 token 检查与原子写入；应用回执写入同一个分子文件，支持幂等重试和恢复。UI 应用失败时还原暂存的 Action，不污染画布或历史。

## 自动验证

`pnpm test`：批注、宿主与持久化测试通过，覆盖跨会话读取拒绝、冻结目标、重复提交、选区外修改拒绝、幂等应用、取消和过期版本。

`pnpm run test:browser` 的最终判据：

```text
ALL-PASS: P0 browser acceptance
ALL-PASS: P1 persistence and Chinese UI acceptance
ALL-PASS: P2 UI/tool bridge acceptance (deterministic model fixture)
```

P2 浏览器链路使用真实 Ketcher/Indigo、实际文件写入和确定性模型夹具，验证提交后改选别的原子仍修改原目标、预览保留原画布、应用保存和撤销、取消保持原结构、非法价态不允许应用、结构改变使批注过期。

## 真实 Agent 验证

使用安装的官方 DSH `0.2.0-rc.2`，通过其支持的独立临时 Web profile 复用现有 DSH 用户配置。实际选定模型为 `DeepSeek-V41-Flash`，推理等级 High。

在新的验证会话中：初始化分子面板 → 选中苯的 C #1 → 提交“替换为氮，其他原子和键保持” → 等待真实 Agent 调用插件工具 → 生成有效预览 → 确认原画布不变 → 人工应用 → 保存 → 撤销恢复。

最终判据：

```text
ALL-PASS: P2 real DSH Agent preview/apply/save/undo
```

结构比较确认应用只改变冻结原子的元素，撤销恢复所有原子和键。证据保存在本地 `test-results/p2-real-agent.json` 及预览/应用截图。

## 官方桌面端复验

前一轮 Windows 自动化曾无法确认当前 URL；本轮重新按精确进程路径筛选唯一 DSH 窗口并重新获取状态后，官方桌面端操作恢复正常。

已通过应用菜单完整退出并重开 `D:\dsh\DeepSeek Harness.exe`，加载 `0.0.3` 宿主。在“dsh-chem-editor P2 集成验证”会话中，实际鼠标选择 C #1 并点击「交给 Agent」，真实 Agent 返回有效预览。桌面端显示修改前后 SVG，点击「应用修改」后显示 N #1 和「已保存」。再点击「撤销」，画布恢复为无 N 的原结构并保存。

对应批注 `ee96ab6c-e92e-4a8d-a252-97417c2be0c2` 的磁盘证据：应用后状态 `applied`，结构版本 4、保存版本 5、N 数量 1；撤销后结构版本 5、保存版本 6、N 数量 0。见 `test-results/p2-desktop-agent.json`。

插件仍链接到官方 Desktop profile 的 `D:\AI项目\dsh-chem`。Web 的自动结构比较与真实模型验证、原生桌面窗口和 IPC 操作分别记录，均已通过。临时 Web 服务已停止，临时 profile 已归档至测试结果目录。已有 P1 分子存档兼容；桌面端留在验证会话供继续体验。

## 实施中修复

Ketcher `getKet()` 会添加空的 `root.connections`、`root.templates` 和原子 `selected` 标记。严格校验曾把这些显示元数据误判成选区外修改。现在只规范化这三个已确认的显示差异，仍拒绝非空连接变化、其他原子元素改变、键和立体字段改变。

改键、基团添加与复杂片段替换仍属于 P3；P2 不推断这些请求的含义，也不直接覆盖整个分子。
