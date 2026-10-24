# A1 草稿原型验收

日期：2026-10-24。范围：草稿会话协议 v2（显式身份映射、会话版本、幂等、步骤事务、修订与回滚），操作词汇沿用现有五类操作。规划与完成判据见 [Agent 融合架构规划](./AGENT_ARCHITECTURE.md) 第 10 节。

## 交付

| 模块 | 职责 |
| --- | --- |
| `src/contracts/draft.ts` | 稳定原子/键引用（`a:`/`b:` 前缀）、草稿步骤与操作类型、运行预算常量 |
| `src/chemistry/draft.ts` | 步骤事务执行（失败整组不变）、新对象扩展可编辑范围、草稿意图与候选核对、草稿上下文视图 |
| `src/host/edit-session-service.ts` | 会话版本（draftRevision）、幂等重放、rewind 到指定步骤、已验证状态跟踪 |
| `src/host/tools/v2.ts` | `chem_begin_edit`、`chem_edit_draft`、`chem_validate_draft`、`chem_propose_draft` 四个 v2 工具 |
| `src/editor.tsx` 草稿模式 | 批注面板可选「草稿模式」复选框，提交时携带 protocolVersion 2；草稿预览、检查反馈与用户确认复用原链路 |
| `src/host/annotation-service.ts` v2 分支 | 草稿命令路由、v1/v2 混用拒绝（wrong_protocol）、迟到校验失效、应用时按草稿版本与意图复核 |

v1 工具与存档格式不变；v2 批注在应用前原画布保持不变，保存失败按原回滚/重试链路处理。

## 验证（2026-10-24 全量重跑）

- `pnpm run check:types`：通过。
- `pnpm run check:architecture`：通过，依赖边界检查覆盖 31 个模块、92 个导入/导出（A0 时为 27/73，增量来自草稿模块）。
- `pnpm test`：24 项通过、0 失败（A0 时为 20 项；`tests/drafts.test.mjs` 新增 4 项：新引用在后续操作中稳定、原子失败/重复请求/版本冲突/范围约束；已验证草稿一次提交、修订使旧提案失效、伪造候选被拒；校验失败可修复、删除引用不回收、取消终止草稿；等坐标原子显式身份映射在删除早期数组项后仍正确）。
- `pnpm run build`：通过（构建内嵌依赖边界检查）。
- `pnpm run test:browser`：七组全部 `ALL-PASS`；新增 `scripts/draft-browser-test.mjs` 覆盖真实 Ketcher/Indigo 链路的「先接丙基再修改新建末端原子」与「化学校验失败（F 三键）后 rewind 修复」，两者均验证原画布不被草稿修改、保存失败回滚、一次应用与一步撤销。

对照第 10 节 A1 完成判据：先接丙基再修改其新建末端原子（浏览器组一）、失败整组回滚（单元原子失败项、浏览器保存回滚）、旧提案/旧版本拒绝（单元重放与版本冲突项）、一个最终预览、一次应用、一步撤销（浏览器两组）。

## 当前边界

草稿仍只使用现有五类操作与九种基团；动态片段（A2）、通用图编辑（A3）未开始。v1 批注行为与文档版本不变。

本轮验证使用确定性 Agent fixture 与真实 Ketcher/Indigo 浏览器实例；`scripts/draft-real-agent-test.mjs` 需另行配置官方 DSH 临时 Web profile，尚未运行，Desktop 原生验收也未执行。两者完成前，草稿链路不声明为已验证能力。
